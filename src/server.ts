import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { type FileId, fileId, removeIfOurs } from "./paths";
import {
	PROTOCOL_VERSION,
	type ActionOutcome,
	type AnswerResult,
	type ChatSnapshot,
	type ClientInfo,
	type Feature,
	type Item,
	type ServerMessage,
	type SessionInfo,
	type ShutdownReason,
} from "./protocol";

export const MAX_LINE_BYTES = 1024 * 1024;
export const MAX_CLIENTS = 32;
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** A connection that hasn't said hello by then is closed, so idle connections can't hold slots. */
export const HELLO_TIMEOUT_MS = 5000;
export const CONTROL_OFF = "Control is off for this pi.";
/** After `goodbye`, a client that doesn't let the connection end is destroyed after this long. */
const CLOSE_GRACE_MS = 1000;

/** What the server needs from the registry. */
export interface ServerHandler {
	items(): Item[];
	answer(id: string, answer: unknown, from: ClientInfo, reply: (result: AnswerResult) => void): void;
	/** The session name for `welcome.session.name`, if any. */
	sessionName?(): string | undefined;
	/** The whole chat picture for a `chat: true` client's welcome. Without it, "chat" isn't offered. */
	chatSnapshot?(): ChatSnapshot;
	/** Run a client action (only called when control is on). `action` is the raw message with a string reqId. */
	action?(action: Record<string, unknown>, from: ClientInfo, reply: (outcome: ActionOutcome) => void): void;
}

export interface ListenOptions {
	socketPath: string;
	session: SessionInfo;
	handler: ServerHandler;
	log?: (message: string) => void;
	/** pi-live's package version, for `welcome.version`. */
	version?: string;
	/** Whether clients may act on pi. */
	control?: boolean;
	/** Defaults to HELLO_TIMEOUT_MS. For tests. */
	helloTimeoutMs?: number;
}

interface Client {
	socket: Socket;
	/** Set by `hello`; only clients with a connId get broadcasts. */
	info?: ClientInfo;
	/** Said `chat: true` in hello. */
	chat: boolean;
	pending: Buffer[];
	pendingBytes: number;
	closing: boolean;
	helloTimer?: ReturnType<typeof setTimeout>;
}

/** The session's NDJSON socket server. */
export class LiveServer {
	private readonly clients = new Set<Client>();
	private nextConnId = 1;
	private closed = false;

	private constructor(
		private readonly server: Server,
		readonly socketPath: string,
		/** The socket file as created by listen; undefined on Windows. */
		readonly socketId: FileId | undefined,
		private readonly session: SessionInfo,
		private readonly handler: ServerHandler,
		private readonly log: (message: string) => void,
		private readonly helloTimeoutMs: number,
		private readonly version: string | undefined,
		private readonly control: boolean,
	) {
		server.on("connection", (socket) => this.guard(() => this.onConnection(socket)));
		server.on("error", (error) => this.log(`socket server error: ${error.message}`));
	}

	/** Listen on `socketPath` and chmod it 0600. The path must not exist. */
	/**
	 * Listen on `socketPath` (0600). Fails with EEXIST/EADDRINUSE if the path exists.
	 *
	 * On Unix, Node/libuv unlinks the listen path by name when the server closes,
	 * which could delete a newer pi's socket at the same path. So we listen on a
	 * unique temp name in the same dir, chmod it, hard-link it to `socketPath`
	 * (EEXIST if taken, never replaces) and unlink the temp name. Only `close()`
	 * removes `socketPath`, and only while it is still ours.
	 */
	static listen(options: ListenOptions): Promise<LiveServer> {
		const log = options.log ?? (() => {});
		const unix = process.platform !== "win32";
		const listenPath = unix
			? join(dirname(options.socketPath), `.${randomBytes(4).toString("hex")}`)
			: options.socketPath;
		return new Promise((resolve, reject) => {
			const server = createServer();
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(listenPath, () => {
				server.off("error", onError);
				let socketId: FileId | undefined;
				try {
					if (unix) {
						chmodSync(listenPath, 0o600);
						linkSync(listenPath, options.socketPath);
						unlinkSync(listenPath);
						socketId = fileId(options.socketPath);
					}
				} catch (error) {
					server.close();
					reject(error);
					return;
				}
				// Don't keep pi's process alive just for the door.
				server.unref();
				resolve(
					new LiveServer(
						server,
						options.socketPath,
						socketId,
						options.session,
						options.handler,
						log,
						options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
						options.version,
						options.control === true,
					),
				);
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

	/**
	 * Send `goodbye` (with pi's shutdown reason, if given), end every connection,
	 * stop listening and unlink the socket if it's still ours. Doesn't wait for clients.
	 */
	close(shutdown?: ShutdownReason): void {
		if (this.closed) return;
		this.closed = true;
		for (const client of this.clients) {
			if (client.info) this.send(client, { type: "goodbye", reason: "session_shutdown", ...(shutdown ? { shutdown } : {}) });
			this.end(client);
		}
		this.server.close();
		removeIfOurs(this.socketPath, this.socketId);
	}

	private onConnection(socket: Socket): void {
		socket.unref();
		const client: Client = { socket, chat: false, pending: [], pendingBytes: 0, closing: false };
		socket.on("error", () => {
			// Disconnects (EPIPE, ECONNRESET) are normal; "close" follows.
		});
		socket.on("close", () => {
			clearTimeout(client.helloTimer);
			this.clients.delete(client);
		});
		if (this.closed || this.clients.size >= MAX_CLIENTS) {
			this.reject(client, "too many clients");
			return;
		}
		this.clients.add(client);
		client.helloTimer = setTimeout(() => {
			if (!client.info) this.reject(client, "expected hello");
		}, this.helloTimeoutMs);
		client.helloTimer.unref();
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
			clearTimeout(client.helloTimer);
			client.info = { connId: `c${this.nextConnId++}`, name };
			const features: Feature[] = [];
			if (this.handler.chatSnapshot) features.push("chat");
			if (this.control) features.push("control");
			client.chat = msg.chat === true && this.handler.chatSnapshot !== undefined;
			const sessionName = this.handler.sessionName?.();
			// Snapshot and write in the same tick, so no change falls in between.
			this.send(client, {
				type: "welcome",
				protocol: PROTOCOL_VERSION,
				...(this.version !== undefined ? { version: this.version } : {}),
				features,
				control: this.control,
				session: sessionName ? { ...this.session, name: sessionName } : this.session,
				connId: client.info.connId,
				items: this.handler.items(),
				...(client.chat && this.handler.chatSnapshot ? { chat: this.handler.chatSnapshot() } : {}),
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
			case "action": {
				const { reqId } = msg;
				if (typeof reqId !== "string") return this.error(client, "action needs a string reqId");
				const reply = (outcome: ActionOutcome) => this.send(client, { type: "action_result", reqId, ...outcome });
				if (!this.control) return reply({ ok: false, error: CONTROL_OFF });
				if (!this.handler.action) return reply({ ok: false, error: "pi does not know that action." });
				this.handler.action(msg, client.info, reply);
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
