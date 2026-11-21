import { chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { removeFile } from "./paths";
import { PROTOCOL_VERSION, type AnswerResult, type ClientInfo, type Item, type ServerMessage, type SessionInfo } from "./protocol";

export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_CLIENTS = 32;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** After `goodbye`, a client that doesn't let the connection end is destroyed after this long. */
const CLOSE_GRACE_MS = 1000;

/** What the server needs from the registry. */
export interface ServerHandler {
	items(): Item[];
	answer(id: string, answer: unknown, from: ClientInfo, reply: (result: AnswerResult) => void): void;
}

export interface ListenOptions {
	socketPath: string;
	session: SessionInfo;
	handler: ServerHandler;
	log?: (message: string) => void;
}

interface Client {
	socket: Socket;
	/** Set by `hello`; only clients with a connId get broadcasts. */
	info?: ClientInfo;
	pending: Buffer[];
	pendingBytes: number;
	closing: boolean;
}

/** The session's NDJSON socket server. */
export class LiveServer {
	private readonly clients = new Set<Client>();
	private nextConnId = 1;
	private closed = false;

	private constructor(
		private readonly server: Server,
		readonly socketPath: string,
		private readonly session: SessionInfo,
		private readonly handler: ServerHandler,
		private readonly log: (message: string) => void,
	) {
		server.on("connection", (socket) => this.guard(() => this.onConnection(socket)));
		server.on("error", (error) => this.log(`socket server error: ${error.message}`));
	}

	/** Listen on `socketPath` and chmod it 0600. The path must not exist. */
	static listen(options: ListenOptions): Promise<LiveServer> {
		const log = options.log ?? (() => {});
		return new Promise((resolve, reject) => {
			const server = createServer();
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(options.socketPath, () => {
				server.off("error", onError);
				try {
					if (process.platform !== "win32") chmodSync(options.socketPath, 0o600);
				} catch (error) {
					server.close();
					reject(error);
					return;
				}
				// Don't keep pi's process alive just for the door.
				server.unref();
				resolve(new LiveServer(server, options.socketPath, options.session, options.handler, log));
			});
		});
	}

	/** Number of open connections, with or without hello. */
	get clientCount(): number {
		return this.clients.size;
	}

	/** Send to every client that has said hello. */
	broadcast(message: ServerMessage): void {
		if (this.closed) return;
		for (const client of this.clients) {
			if (client.info) this.send(client, message);
		}
	}

	/** Send `goodbye`, end every connection, stop listening and unlink the socket. Doesn't wait for clients. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const client of this.clients) {
			if (client.info) this.send(client, { type: "goodbye", reason: "session_shutdown" });
			this.end(client);
		}
		this.server.close();
		if (process.platform !== "win32") {
			try {
				removeFile(this.socketPath);
			} catch (error) {
				this.log(`could not remove ${this.socketPath}: ${(error as Error).message}`);
			}
		}
	}

	private onConnection(socket: Socket): void {
		socket.unref();
		const client: Client = { socket, pending: [], pendingBytes: 0, closing: false };
		socket.on("error", () => {
			// Disconnects (EPIPE, ECONNRESET) are normal; "close" follows.
		});
		socket.on("close", () => this.clients.delete(client));
		if (this.closed || this.clients.size >= MAX_CLIENTS) {
			this.reject(client, "too many clients");
			return;
		}
		this.clients.add(client);
		socket.on("data", (chunk: Buffer) => this.guard(() => this.onData(client, chunk)));
	}

	private onData(client: Client, chunk: Buffer): void {
		let start = 0;
		while (!client.closing) {
			const newline = chunk.indexOf(0x0a, start);
			if (newline === -1) break;
			const part = chunk.subarray(start, newline);
			start = newline + 1;
			if (client.pendingBytes + part.length > MAX_LINE_BYTES) {
				this.reject(client, "line too long");
				return;
			}
			const line = client.pending.length ? Buffer.concat([...client.pending, part]) : part;
			client.pending = [];
			client.pendingBytes = 0;
			this.onLine(client, line.toString("utf8"));
		}
		if (client.closing || start >= chunk.length) return;
		const rest = chunk.subarray(start);
		if (client.pendingBytes + rest.length > MAX_LINE_BYTES) {
			this.reject(client, "line too long");
			return;
		}
		client.pending.push(Buffer.from(rest));
		client.pendingBytes += rest.length;
	}

	private onLine(client: Client, line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			this.reject(client, "invalid JSON");
			return;
		}
		const msg = (typeof message === "object" && message !== null ? message : {}) as Record<string, unknown>;

		if (!client.info) {
			if (msg.type !== "hello") return this.reject(client, "expected hello");
			if (msg.protocol !== PROTOCOL_VERSION) return this.reject(client, "unsupported protocol");
			const name = (msg.client as Record<string, unknown> | undefined)?.name;
			if (typeof name !== "string") return this.reject(client, "invalid hello");
			client.info = { connId: `c${this.nextConnId++}`, name };
			// Snapshot and write in the same tick, so no change falls in between.
			this.send(client, {
				type: "welcome",
				protocol: PROTOCOL_VERSION,
				session: this.session,
				connId: client.info.connId,
				items: this.handler.items(),
			});
			return;
		}

		switch (msg.type) {
			case "ping":
				if (typeof msg.reqId !== "string") return this.error(client, "ping needs a string reqId");
				this.send(client, { type: "pong", reqId: msg.reqId });
				return;
			case "answer": {
				const { reqId, id } = msg;
				if (typeof reqId !== "string" || typeof id !== "string") {
					return this.error(client, "answer needs string reqId and id");
				}
				this.handler.answer(id, msg.answer, client.info, (result) =>
					this.send(client, { type: "answer_result", reqId, id, ...result }),
				);
				return;
			}
			case "hello":
				return this.error(client, "already said hello");
			default:
				return this.error(client, "unknown message type");
		}
	}

	private send(client: Client, message: ServerMessage): void {
		if (client.closing || client.socket.destroyed) return;
		const ok = client.socket.write(`${JSON.stringify(message)}\n`);
		if (!ok && client.socket.writableLength > MAX_BUFFERED_BYTES) {
			this.log(`dropping ${client.info?.name ?? "client"} (${client.info?.connId ?? "no hello"}): not reading`);
			client.closing = true;
			client.socket.destroy();
		}
	}

	private error(client: Client, message: string): void {
		this.send(client, { type: "error", message });
	}

	/** Send `error` and close the connection. */
	private reject(client: Client, message: string): void {
		this.error(client, message);
		this.end(client);
	}

	private end(client: Client): void {
		if (client.closing) return;
		client.closing = true;
		client.socket.end();
		setTimeout(() => client.socket.destroy(), CLOSE_GRACE_MS).unref();
	}

	private guard(fn: () => void): void {
		try {
			fn();
		} catch (error) {
			this.log(`socket handler error: ${(error as Error).message}`);
		}
	}
}
