import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A short temp dir (macOS tmpdir is long; socket paths must stay under 100 bytes). */
export function tempDir(): { dir: string; cleanup(): void } {
	const base = process.platform === "darwin" ? "/tmp" : tmpdir();
	const dir = mkdtempSync(join(base, "pl-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface TestClient {
	socket: Socket;
	messages: Array<Record<string, unknown>>;
	closed: Promise<void>;
	isClosed(): boolean;
	send(message: unknown): void;
	sendRaw(text: string): void;
	/** Resolve with the first message (from index `from`) matching `pred`. */
	next(pred?: (m: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export async function openClient(path: string): Promise<TestClient> {
	const socket = connect(path);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const messages: Array<Record<string, unknown>> = [];
	let buffer = "";
	let closed = false;
	let cursor = 0;
	const waiters = new Set<() => void>();
	socket.setEncoding("utf8");
	socket.on("data", (data: string) => {
		buffer += data;
		let i = buffer.indexOf("\n");
		while (i !== -1) {
			messages.push(JSON.parse(buffer.slice(0, i)));
			buffer = buffer.slice(i + 1);
			i = buffer.indexOf("\n");
		}
		for (const w of waiters) w();
	});
	socket.on("error", () => {});
	const closedPromise = new Promise<void>((resolve) =>
		socket.once("close", () => {
			closed = true;
			for (const w of waiters) w();
			resolve();
		}),
	);
	return {
		socket,
		messages,
		closed: closedPromise,
		isClosed: () => closed,
		send: (message) => socket.write(`${JSON.stringify(message)}\n`),
		sendRaw: (text) => socket.write(text),
		next(pred = () => true, timeoutMs = 2000) {
			return new Promise((resolve, reject) => {
				const check = () => {
					while (cursor < messages.length) {
						const m = messages[cursor++]!;
						if (pred(m)) {
							cleanup();
							resolve(m);
							return;
						}
					}
					if (closed) {
						cleanup();
						reject(new Error("connection closed"));
					}
				};
				const timer = setTimeout(() => {
					cleanup();
					reject(new Error(`timed out; got ${JSON.stringify(messages)}`));
				}, timeoutMs);
				const cleanup = () => {
					clearTimeout(timer);
					waiters.delete(check);
				};
				waiters.add(check);
				check();
			});
		},
	};
}

/** Open a client and say hello; resolves with the welcome. */
export async function helloClient(path: string, name = "test") {
	const client = await openClient(path);
	client.send({ type: "hello", protocol: 1, client: { name } });
	const welcome = await client.next((m) => m.type === "welcome");
	return { client, welcome };
}

export const tick = () => new Promise((r) => setTimeout(r, 20));
