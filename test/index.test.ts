import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import piLive, { GUARD_KEY, PKG_VERSION } from "../index";
import { writeSidecar } from "../src/paths";
import { CHANNEL_CLOSED, CHANNEL_PARK, CHANNEL_READY, CHANNEL_WHO, type ParkRequest, type ParkTicket, type ReadyInfo } from "../src/protocol";
import { helloClient, tempDir, type TestClient } from "./helpers";

type Handler = (event: unknown, ctx: unknown) => unknown;

/** Fake bus with pi's EventBus shape: sync emit, on() returns unsubscribe. */
function fakeBus() {
	const emitter = new EventEmitter();
	return {
		emitter,
		emit: (channel: string, data: unknown) => emitter.emit(channel, data),
		on(channel: string, handler: (data: unknown) => void) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}

const bus = fakeBus();

/** Load one copy of the extension into a fake pi. */
function load() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		events: bus,
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	piLive(pi as never);
	const fire = async (event: string, payload: unknown, ctx: unknown) => {
		for (const h of handlers.get(event) ?? []) await h(payload, ctx);
	};
	return { handlers, fire };
}

const notes: string[] = [];
function ctxFor(sessionId: string, mode = "tui") {
	return {
		mode,
		hasUI: mode === "tui",
		ui: { notify: (msg: string) => notes.push(msg) },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: (): string | undefined => `/x/${sessionId}.jsonl`,
			getCwd: () => "/x",
		},
	};
}

async function startSession(sessionId = "s1", mode = "tui") {
	const ext = load();
	const ctx = ctxFor(sessionId, mode);
	await ext.fire("session_start", { reason: "startup" }, ctx);
	return { ...ext, ctx, shutdown: () => ext.fire("session_shutdown", { reason: "quit" }, ctx) };
}

function park(id: string) {
	const holder: { ticket?: ParkTicket; accepted: boolean } = { accepted: false };
	const request: ParkRequest = {
		protocol: 1,
		id,
		owner: "ask_user",
		kind: "ask_user.question",
		title: id,
		view: {},
		answer: () => ({ status: "delivered" }),
		accept: (t) => {
			holder.ticket = t;
			holder.accepted = true;
		},
	};
	bus.emit(CHANNEL_PARK, request);
	return holder;
}

function who(): ReadyInfo | undefined {
	let got: ReadyInfo | undefined;
	bus.emit(CHANNEL_WHO, { reply: (info: ReadyInfo) => (got = info) });
	return got;
}

const g = globalThis as Record<symbol, unknown>;
let tmp: ReturnType<typeof tempDir>;
let dir: string;
const events: Array<[string, unknown]> = [];
const clients: TestClient[] = [];
const savedEnv = { ...process.env };

beforeEach(() => {
	tmp = tempDir();
	dir = join(tmp.dir, "live");
	process.env.PI_CODING_AGENT_DIR = tmp.dir;
	process.env.PI_LIVE_DIR = dir;
	for (const key of ["PI_LIVE_ENABLED", "PI_LIVE_CONTROL", "PI_LIVE_TERMINAL", "HC_TERMINAL_ID"]) delete process.env[key];
	notes.length = 0;
	events.length = 0;
	for (const ch of [CHANNEL_READY, CHANNEL_CLOSED]) bus.emitter.on(ch, (d) => events.push([ch, d]));
});

afterEach(() => {
	for (const c of clients.splice(0)) c.socket.destroy();
	bus.emitter.removeAllListeners();
	delete g[GUARD_KEY];
	process.env = { ...savedEnv };
	tmp.cleanup();
});

test("PKG_VERSION matches package.json", () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
	expect(PKG_VERSION).toBe(pkg.version);
});

describe("guard", () => {
	test("two copies in one process: only one subscribes", async () => {
		const first = load();
		const second = load();
		expect(second.handlers.size).toBe(0);
		await first.fire("session_start", { reason: "startup" }, ctxFor("s1"));
		expect(bus.emitter.listenerCount(CHANNEL_PARK)).toBe(1);
		expect(g[GUARD_KEY]).toEqual({ version: PKG_VERSION });
		await first.fire("session_shutdown", { reason: "quit" }, ctxFor("s1"));
	});

	test("shutdown releases the guard so the next runtime can claim it", async () => {
		const s = await startSession();
		await s.shutdown();
		expect(g[GUARD_KEY]).toBeUndefined();
		const next = await startSession("s2");
		expect(next.handlers.size).toBeGreaterThan(0);
		expect(bus.emitter.listenerCount(CHANNEL_PARK)).toBe(1);
		await next.shutdown();
	});

	test("a loser's shutdown doesn't release the winner's claim", async () => {
		const winner = await startSession();
		const claim = g[GUARD_KEY];
		load(); // loser registers no handlers at all, so it can't release anything
		expect(g[GUARD_KEY]).toBe(claim);
		await winner.shutdown();
	});
});

describe("lifecycle", () => {
	test("session_start opens the socket, writes the sidecar and emits ready", async () => {
		const s = await startSession("s1");
		const socketPath = join(dir, "s1.sock");
		expect(events).toEqual([[CHANNEL_READY, { protocol: 1, sessionId: "s1", socketPath }]]);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
		const sidecarPath = join(dir, "s1.json");
		expect(statSync(sidecarPath).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(sidecarPath, "utf8"))).toMatchObject({
			protocol: 1,
			sessionId: "s1",
			sessionFile: "/x/s1.jsonl",
			cwd: "/x",
			pid: process.pid,
			socketPath,
		});
		const { welcome } = await helloClient(socketPath);
		expect(welcome.session).toEqual({ id: "s1", file: "/x/s1.jsonl", cwd: "/x", pid: process.pid, mode: "tui" });
		await s.shutdown();
	});

	test("ephemeral session: no file in sidecar or welcome", async () => {
		const ext = load();
		const ctx = ctxFor("eph");
		ctx.sessionManager.getSessionFile = () => undefined;
		await ext.fire("session_start", { reason: "startup" }, ctx);
		const { client, welcome } = await helloClient(join(dir, "eph.sock"));
		clients.push(client);
		expect("file" in (welcome.session as object)).toBe(false);
		expect("sessionFile" in JSON.parse(readFileSync(join(dir, "eph.json"), "utf8"))).toBe(false);
		await ext.fire("session_shutdown", { reason: "quit" }, ctx);
	});

	test("shutdown closes items, says goodbye, removes files and emits closed", async () => {
		const s = await startSession("s1");
		const { client } = await helloClient(join(dir, "s1.sock"));
		clients.push(client);
		const p = park("q1");
		expect(p.accepted).toBe(true);
		await client.next((m) => m.type === "item_opened");
		await s.shutdown();
		expect(await client.next()).toEqual({ type: "item_closed", id: "q1", outcome: { by: "shutdown" } });
		expect(await client.next()).toEqual({ type: "goodbye", reason: "session_shutdown", shutdown: "quit" });
		await client.closed;
		expect(readdirSync(dir)).toEqual([]);
		expect(events.at(-1)).toEqual([CHANNEL_CLOSED, { sessionId: "s1" }]);
		expect(bus.emitter.listenerCount(CHANNEL_PARK)).toBe(0);
		expect(bus.emitter.listenerCount(CHANNEL_WHO)).toBe(0);
		expect(park("q2").accepted).toBe(false);
	});

	test("a new session_start makes a new socket", async () => {
		const a = await startSession("s1");
		await a.shutdown();
		const b = await startSession("s2");
		expect(readdirSync(dir).sort()).toEqual(["s2.json", "s2.sock"]);
		expect(who()?.socketPath).toBe(join(dir, "s2.sock"));
		await b.shutdown();
	});

	test("print and json modes do nothing", async () => {
		for (const mode of ["print", "json"]) {
			const s = await startSession("s1", mode);
			expect(existsSync(dir)).toBe(false);
			expect(park("q").accepted).toBe(false);
			await s.shutdown();
		}
		expect(events).toEqual([]);
	});

	test("rpc mode runs", async () => {
		const s = await startSession("s1", "rpc");
		expect(existsSync(join(dir, "s1.sock"))).toBe(true);
		await s.shutdown();
	});

	test("shutdown without a start is harmless", async () => {
		const ext = load();
		await ext.fire("session_shutdown", { reason: "quit" }, ctxFor("s1"));
		expect(g[GUARD_KEY]).toBeUndefined();
	});
});

describe("bus", () => {
	test("park is accepted synchronously and broadcast", async () => {
		const s = await startSession();
		const { client } = await helloClient(join(dir, "s1.sock"));
		clients.push(client);
		expect(park("q1").accepted).toBe(true);
		expect(await client.next()).toMatchObject({ type: "item_opened", item: { id: "q1" } });
		await s.shutdown();
	});

	test("pi-live:who replies synchronously with the current socket", async () => {
		expect(who()).toBeUndefined();
		const s = await startSession();
		expect(who()).toEqual({ protocol: 1, sessionId: "s1", socketPath: join(dir, "s1.sock") });
		await s.shutdown();
		expect(who()).toBeUndefined();
	});
});

describe("settings", () => {
	test("PI_LIVE_ENABLED=0: guard claimed, no socket, no park subscriber", async () => {
		process.env.PI_LIVE_ENABLED = "0";
		const s = await startSession();
		expect(g[GUARD_KEY]).toBeDefined();
		expect(load().handlers.size).toBe(0);
		expect(existsSync(dir)).toBe(false);
		expect(bus.emitter.listenerCount(CHANNEL_PARK)).toBe(0);
		expect(who()).toBeUndefined();
		await s.shutdown();
	});

	test("enabled: false in pi-live.json is honored and re-read each session_start", async () => {
		const file = join(tmp.dir, "pi-live.json");
		writeFileSync(file, JSON.stringify({ enabled: false }));
		const a = await startSession("s1");
		expect(existsSync(dir)).toBe(false);
		await a.shutdown();
		writeFileSync(file, JSON.stringify({ enabled: true }));
		const b = await startSession("s2");
		expect(existsSync(join(dir, "s2.sock"))).toBe(true);
		await b.shutdown();
	});

	test("invalid settings JSON: logged, off for the session", async () => {
		writeFileSync(join(tmp.dir, "pi-live.json"), "{");
		const s = await startSession();
		expect(existsSync(dir)).toBe(false);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toStartWith("[pi-live] Failed to parse pi-live settings");
		await s.shutdown();
	});
});

describe("files", () => {
	test("a stale socket at our own path is replaced", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "s1.sock");
		const child = spawnSync(process.execPath, [
			"-e",
			`require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
		]);
		expect(child.status).toBe(0);
		const s = await startSession("s1");
		await helloClient(path).then(({ client }) => clients.push(client));
		await s.shutdown();
	});

	test("a live socket for the same session is not stolen", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, "s1.sock");
		const other = createServer();
		await new Promise<void>((r) => other.listen(path, r));
		writeSidecar(join(dir, "s1.json"), {
			protocol: 1, sessionId: "s1", cwd: "/x", pid: process.pid, startedAt: "", socketPath: path,
		});
		const s = await startSession("s1");
		expect(notes.join("\n")).toContain("already served by another pi");
		expect(events).toEqual([]);
		expect(bus.emitter.listenerCount(CHANNEL_PARK)).toBe(0);
		await s.shutdown();
		expect(existsSync(path)).toBe(true);
		expect(existsSync(join(dir, "s1.json"))).toBe(true);
		other.close();
	});

	test("exit without session_shutdown removes the socket and sidecar", () => {
		const script = `
			const piLive = require(${JSON.stringify(join(import.meta.dir, "..", "index.ts"))}).default;
			const handlers = {};
			piLive({ events: { emit() {}, on() { return () => {}; } }, on(e, h) { handlers[e] = h; } });
			handlers.session_start({}, {
				mode: "rpc", hasUI: false, ui: {},
				sessionManager: { getSessionId: () => "ex", getSessionFile: () => undefined, getCwd: () => "/" },
			}).then(() => {
				if (!require("node:fs").existsSync(${JSON.stringify(join(dir, "ex.sock"))})) process.exit(2);
				process.exit(0);
			});
		`;
		const child = spawnSync(process.execPath, ["-e", script], { env: process.env });
		expect(child.stderr.toString()).toBe("");
		expect(child.status).toBe(0);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("0.2 session fields, goodbye and control", () => {
	test("sidecar and welcome carry mode, terminal and version", async () => {
		process.env.HC_TERMINAL_ID = "hc9";
		const s = await startSession("s1", "rpc");
		const sidecar = JSON.parse(readFileSync(join(dir, "s1.json"), "utf8"));
		expect(sidecar).toMatchObject({ mode: "rpc", terminal: "hc9", version: PKG_VERSION });
		const { client, welcome } = await helloClient(join(dir, "s1.sock"));
		clients.push(client);
		expect(welcome).toMatchObject({ version: PKG_VERSION, control: true, session: { mode: "rpc", terminal: "hc9" } });
		await s.shutdown();
	});

	test("PI_LIVE_TERMINAL beats HC_TERMINAL_ID; no terminal → omitted", async () => {
		process.env.HC_TERMINAL_ID = "hc9";
		process.env.PI_LIVE_TERMINAL = "mine";
		let s = await startSession("s1");
		expect(JSON.parse(readFileSync(join(dir, "s1.json"), "utf8")).terminal).toBe("mine");
		await s.shutdown();
		delete process.env.HC_TERMINAL_ID;
		delete process.env.PI_LIVE_TERMINAL;
		s = await startSession("s1");
		expect("terminal" in JSON.parse(readFileSync(join(dir, "s1.json"), "utf8"))).toBe(false);
		await s.shutdown();
	});

	for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
		test(`goodbye says shutdown: ${reason}`, async () => {
			const ext = load();
			const ctx = ctxFor("s1");
			await ext.fire("session_start", { reason: "startup" }, ctx);
			const { client } = await helloClient(join(dir, "s1.sock"));
			clients.push(client);
			await ext.fire("session_shutdown", { reason }, ctx);
			expect(await client.next()).toEqual({ type: "goodbye", reason: "session_shutdown", shutdown: reason });
		});
	}

	test("/reload keeps the session id: the old sidecar is gone before the new one is written", async () => {
		const ext = load();
		const ctx = ctxFor("s1");
		await ext.fire("session_start", { reason: "startup" }, ctx);
		const sidecarPath = join(dir, "s1.json");
		const first = JSON.parse(readFileSync(sidecarPath, "utf8")).startedAt;
		await ext.fire("session_shutdown", { reason: "reload" }, ctx);
		expect(existsSync(sidecarPath)).toBe(false);
		expect(existsSync(join(dir, "s1.sock"))).toBe(false);
		await new Promise((r) => setTimeout(r, 5)); // a distinct startedAt
		const next = load();
		await next.fire("session_start", { reason: "reload" }, ctx);
		expect(JSON.parse(readFileSync(sidecarPath, "utf8")).startedAt).not.toBe(first);
		const { client } = await helloClient(join(dir, "s1.sock"));
		clients.push(client);
		await next.fire("session_shutdown", { reason: "quit" }, ctx);
	});

	test("a trusted project's { control: false } turns control off; untrusted is ignored", async () => {
		const cwd = join(tmp.dir, "proj");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "pi-live.json"), JSON.stringify({ control: false }));
		for (const trusted of [true, false]) {
			const ext = load();
			const ctx = { ...ctxFor("s1"), isProjectTrusted: () => trusted };
			ctx.sessionManager.getCwd = () => cwd;
			await ext.fire("session_start", { reason: "startup" }, ctx);
			const { client, welcome } = await helloClient(join(dir, "s1.sock"));
			clients.push(client);
			expect(welcome.control).toBe(!trusted);
			await ext.fire("session_shutdown", { reason: "quit" }, ctx);
		}
	});

	test("PI_LIVE_CONTROL=0: actions refused", async () => {
		process.env.PI_LIVE_CONTROL = "0";
		const s = await startSession("s1");
		const { client, welcome } = await helloClient(join(dir, "s1.sock"));
		clients.push(client);
		expect(welcome).toMatchObject({ control: false });
		expect(welcome.features).not.toContain("control");
		client.send({ type: "action", reqId: "a1", op: "stop" });
		expect(await client.next()).toEqual({ type: "action_result", reqId: "a1", ok: false, error: "Control is off for this pi." });
		await s.shutdown();
	});
});
