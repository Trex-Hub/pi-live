import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ParkRequest, ParkTicket, SessionInfo } from "../src/protocol";
import { Registry } from "../src/registry";
import { LiveServer, MAX_CLIENTS, MAX_LINE_BYTES } from "../src/server";
import { helloClient, openClient, tempDir, tick, type TestClient } from "./helpers";

const session: SessionInfo = { id: "s1", file: "/x/s1.jsonl", cwd: "/x", pid: process.pid };

let tmp: ReturnType<typeof tempDir>;
let server: LiveServer;
let registry: Registry;
let socketPath: string;
const clients: TestClient[] = [];

beforeEach(async () => {
	tmp = tempDir();
	socketPath = join(tmp.dir, "s1.sock");
	registry = new Registry({
		opened: (item) => server.broadcast({ type: "item_opened", item }),
		closed: (id, outcome) => server.broadcast({ type: "item_closed", id, outcome }),
	});
	server = await LiveServer.listen({ socketPath, session, handler: registry });
});

afterEach(() => {
	for (const c of clients.splice(0)) c.socket.destroy();
	server.close();
	tmp.cleanup();
});

async function hello(name = "test") {
	const result = await helloClient(socketPath, name);
	clients.push(result.client);
	return result;
}

async function raw() {
	const client = await openClient(socketPath);
	clients.push(client);
	return client;
}

function park(id: string, answer: ParkRequest["answer"] = () => ({ status: "delivered" })) {
	const holder: { ticket?: ParkTicket } = {};
	registry.park({
		protocol: 1,
		id,
		owner: "ask_user",
		kind: "ask_user.question",
		title: `q ${id}`,
		view: { id },
		answer,
		accept: (t: ParkTicket) => {
			holder.ticket = t;
		},
	});
	return holder;
}

describe("socket", () => {
	test("socket file is 0600", () => {
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
	});

	test("close removes the socket file", () => {
		server.close();
		expect(() => statSync(socketPath)).toThrow();
	});

	test("close leaves a socket that someone else re-created at the same path", async () => {
		unlinkSync(socketPath);
		const other = await LiveServer.listen({ socketPath, session, handler: registry });
		server.close();
		expect(statSync(socketPath).isSocket()).toBe(true);
		const { client } = await hello();
		expect(client.messages[0]).toMatchObject({ type: "welcome" });
		other.close();
		expect(existsSync(socketPath)).toBe(false);
	});

	test("listen refuses an existing path and leaves no temp files", async () => {
		await expect(LiveServer.listen({ socketPath, session, handler: registry })).rejects.toMatchObject({ code: "EEXIST" });
		await tick();
		expect(readdirSync(tmp.dir)).toEqual(["s1.sock"]);
	});
});

describe("welcome and stream", () => {
	test("welcome carries session, connId and items oldest first", async () => {
		park("a");
		park("b");
		const { welcome } = await hello();
		expect(welcome).toMatchObject({ type: "welcome", protocol: 1, session, connId: "c1" });
		expect((welcome.items as Array<{ id: string }>).map((i) => i.id)).toEqual(["a", "b"]);
	});

	test("snapshot then changes in order", async () => {
		park("a");
		const b = park("b");
		const { client } = await hello();
		park("c");
		b.ticket!.close({ by: "keyboard" });
		expect(await client.next()).toMatchObject({ type: "item_opened", item: { id: "c" } });
		expect(await client.next()).toEqual({ type: "item_closed", id: "b", outcome: { by: "keyboard" } });
	});

	test("clients before hello get no broadcasts", async () => {
		const quiet = await raw();
		const { client } = await hello();
		park("a");
		await client.next((m) => m.type === "item_opened");
		await tick();
		expect(quiet.messages).toEqual([]);
	});

	test("ping gets pong", async () => {
		const { client } = await hello();
		client.send({ type: "ping", reqId: "p1" });
		expect(await client.next()).toEqual({ type: "pong", reqId: "p1" });
	});
});

describe("answers", () => {
	test("delivered: answering client gets the result before item_closed; others only item_closed", async () => {
		const got: unknown[] = [];
		park("a", (answer) => {
			got.push(answer);
			return { status: "delivered" };
		});
		const { client: one } = await hello("one");
		const { client: two } = await hello("two");
		one.send({ type: "answer", reqId: "r1", id: "a", answer: { kind: "option", value: "Green" } });
		expect(await one.next()).toEqual({ type: "answer_result", reqId: "r1", id: "a", status: "delivered" });
		const closedMsg = { type: "item_closed", id: "a", outcome: { by: "client", client: { connId: "c1", name: "one" } } };
		expect(await one.next()).toEqual(closedMsg);
		expect(await two.next()).toEqual(closedMsg);
		await tick();
		expect(two.messages.filter((m) => m.type === "answer_result")).toEqual([]);
		expect(got).toEqual([{ kind: "option", value: "Green" }]);
	});

	test("invalid keeps the item open", async () => {
		park("a", () => ({ status: "invalid", reason: "nope" }));
		const { client } = await hello();
		client.send({ type: "answer", reqId: "r1", id: "a", answer: 1 });
		expect(await client.next()).toEqual({ type: "answer_result", reqId: "r1", id: "a", status: "invalid", reason: "nope" });
		expect(registry.items()).toHaveLength(1);
	});

	test("throwing answer() gives invalid", async () => {
		park("a", () => {
			throw new Error("bug");
		});
		const { client } = await hello();
		client.send({ type: "answer", reqId: "r1", id: "a", answer: 1 });
		expect(await client.next()).toMatchObject({ status: "invalid", reason: "parker error" });
	});

	test("unknown id gives not_found, closed id gives closed", async () => {
		const a = park("a");
		a.ticket!.close({ by: "keyboard" });
		const { client } = await hello();
		client.send({ type: "answer", reqId: "r1", id: "zzz", answer: 1 });
		client.send({ type: "answer", reqId: "r2", id: "a", answer: 1 });
		expect(await client.next()).toEqual({ type: "answer_result", reqId: "r1", id: "zzz", status: "not_found" });
		expect(await client.next()).toEqual({ type: "answer_result", reqId: "r2", id: "a", status: "closed" });
	});

	test("race: two clients answer in one tick → one delivered, one closed", async () => {
		let calls = 0;
		park("a", () => {
			calls++;
			return { status: "delivered" };
		});
		const { client: one } = await hello("one");
		const { client: two } = await hello("two");
		one.send({ type: "answer", reqId: "r1", id: "a", answer: 1 });
		two.send({ type: "answer", reqId: "r2", id: "a", answer: 2 });
		const results = [
			await one.next((m) => m.type === "answer_result"),
			await two.next((m) => m.type === "answer_result"),
		].map((m) => m.status);
		expect(results.sort()).toEqual(["closed", "delivered"]);
		expect(calls).toBe(1);
	});
});

describe("wire robustness", () => {
	test("message before hello → error and close", async () => {
		const c = await raw();
		c.send({ type: "ping", reqId: "p" });
		expect(await c.next()).toEqual({ type: "error", message: "expected hello" });
		await c.closed;
	});

	test("invalid JSON → error and close, other clients unaffected", async () => {
		const { client: good } = await hello("good");
		const c = await raw();
		c.sendRaw("{nope\n");
		expect(await c.next()).toEqual({ type: "error", message: "invalid JSON" });
		await c.closed;
		good.send({ type: "ping", reqId: "p" });
		expect(await good.next()).toEqual({ type: "pong", reqId: "p" });
	});

	test("line over 1 MiB → error and close", async () => {
		const { client } = await hello();
		client.sendRaw("x".repeat(MAX_LINE_BYTES + 10));
		expect(await client.next()).toEqual({ type: "error", message: "line too long" });
		await client.closed;
	});

	test("a line just under 1 MiB split across chunks is accepted", async () => {
		const { client } = await hello();
		const pad = "x".repeat(MAX_LINE_BYTES - 100);
		client.sendRaw(`{"type":"ping","reqId":"p","pad":"${pad}"}\n`);
		expect(await client.next()).toEqual({ type: "pong", reqId: "p" });
	});

	test("wrong protocol → unsupported protocol and close", async () => {
		const c = await raw();
		c.send({ type: "hello", protocol: 2, client: { name: "x" } });
		expect(await c.next()).toEqual({ type: "error", message: "unsupported protocol" });
		await c.closed;
	});

	test("no hello within the timeout → error and close; hello'd clients stay", async () => {
		const path = join(tmp.dir, "t.sock");
		const quick = await LiveServer.listen({ socketPath: path, session, handler: registry, helloTimeoutMs: 50 });
		try {
			const idle = await openClient(path);
			const { client: good } = await helloClient(path);
			clients.push(idle, good);
			expect(await idle.next()).toEqual({ type: "error", message: "expected hello" });
			await idle.closed;
			await new Promise((r) => setTimeout(r, 80));
			good.send({ type: "ping", reqId: "p" });
			expect(await good.next()).toEqual({ type: "pong", reqId: "p" });
		} finally {
			quick.close();
		}
	});

	test("hello without a client name → error and close", async () => {
		const c = await raw();
		c.send({ type: "hello", protocol: 1 });
		expect(await c.next()).toEqual({ type: "error", message: "invalid hello" });
		await c.closed;
	});

	test("after hello: unknown type, second hello and bad answer get error but stay open", async () => {
		const { client } = await hello();
		client.send({ type: "dance" });
		client.send({ type: "hello", protocol: 1, client: { name: "x" } });
		client.send({ type: "answer", reqId: 1, id: "a" });
		client.send(42);
		client.send({ type: "ping", reqId: "p" });
		expect((await client.next()).type).toBe("error");
		expect((await client.next()).type).toBe("error");
		expect((await client.next()).type).toBe("error");
		expect((await client.next()).type).toBe("error");
		expect(await client.next()).toEqual({ type: "pong", reqId: "p" });
		expect(client.isClosed()).toBe(false);
	});

	test("33rd client is rejected, the others keep working", async () => {
		const ok: TestClient[] = [];
		for (let i = 0; i < MAX_CLIENTS; i++) ok.push((await hello(`c${i}`)).client);
		const extra = await raw();
		expect(await extra.next()).toEqual({ type: "error", message: "too many clients" });
		await extra.closed;
		ok[0]!.send({ type: "ping", reqId: "p" });
		expect(await ok[0]!.next()).toEqual({ type: "pong", reqId: "p" });
		park("a");
		await ok[MAX_CLIENTS - 1]!.next((m) => m.type === "item_opened");
	});

	test("a slot frees up when a client leaves", async () => {
		const all: TestClient[] = [];
		for (let i = 0; i < MAX_CLIENTS; i++) all.push((await hello(`c${i}`)).client);
		all[0]!.socket.destroy();
		await all[0]!.closed;
		await tick();
		await hello("late");
	});

	test("a client that stops reading is dropped once >4 MiB is buffered", async () => {
		const { client: slow } = await hello("slow");
		const { client: fast } = await hello("fast");
		slow.socket.pause();
		const big = "y".repeat(512 * 1024);
		for (let i = 0; i < 40 && server.clientCount === 2; i++) {
			registry.park({
				protocol: 1, id: `v${i}`, owner: "o", kind: "k", title: "t", view: big,
				answer: () => ({ status: "delivered" }), accept: () => {},
			});
			await fast.next((m) => m.type === "item_opened" && (m.item as { id: string }).id === `v${i}`);
		}
		expect(server.clientCount).toBe(1);
		slow.socket.resume();
		await slow.closed;
		fast.send({ type: "ping", reqId: "p" });
		await fast.next((m) => m.type === "pong");
	});
});

describe("close", () => {
	test("goodbye to every client, then the connection ends", async () => {
		const { client: one } = await hello("one");
		const { client: two } = await hello("two");
		server.close();
		expect(await one.next()).toEqual({ type: "goodbye", reason: "session_shutdown" });
		expect(await two.next()).toEqual({ type: "goodbye", reason: "session_shutdown" });
		await one.closed;
		await two.closed;
	});
});
