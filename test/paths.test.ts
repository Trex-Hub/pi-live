import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
	cleanStale,
	ensurePrivateDir,
	fallbackDir,
	isStale,
	pidAlive,
	readSidecar,
	sidecarPathFor,
	socketPathFor,
	writeSidecar,
} from "../src/paths";
import type { Sidecar } from "../src/protocol";
import { tempDir } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
const servers: Server[] = [];

beforeEach(() => {
	tmp = tempDir();
});
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
	tmp.cleanup();
});

function listen(path: string): Promise<Server> {
	return new Promise((resolve) => {
		const s = createServer();
		servers.push(s);
		s.listen(path, () => resolve(s));
	});
}

/** A socket file with nobody listening: listen, then drop the handle without unlinking. */
async function deadSocket(path: string): Promise<void> {
	const child = spawnSync(
		process.execPath,
		["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`],
	);
	expect(child.status).toBe(0);
	expect(existsSync(path)).toBe(true);
}

/** A pid that is certainly dead. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
	return Number(child.stdout.toString());
}

function sidecar(id: string, socketPath: string, pid: number): Sidecar {
	return { protocol: 1, sessionId: id, cwd: "/x", pid, startedAt: new Date().toISOString(), socketPath };
}

describe("socketPathFor", () => {
	test("short path stays in the dir", () => {
		expect(socketPathFor("/tmp/live", "abc")).toBe("/tmp/live/abc.sock");
	});

	test("long path falls back to tmpdir with a hashed name", () => {
		const id = "019a0000-0000-7000-8000-000000000000";
		const path = socketPathFor(`/very/long/${"d".repeat(80)}`, id);
		expect(path.startsWith(fallbackDir())).toBe(true);
		expect(path).toMatch(/\/[0-9a-f]{16}\.sock$/);
		expect(socketPathFor(`/other/${"e".repeat(90)}`, id)).toBe(path);
	});

	test("windows uses a named pipe", () => {
		expect(socketPathFor("C:\\x", "abc", "win32")).toBe("\\\\.\\pipe\\pi-live-abc");
	});

	test("sidecar sits in the live dir", () => {
		expect(sidecarPathFor("/tmp/live", "abc")).toBe("/tmp/live/abc.json");
	});
});

describe("files", () => {
	test("ensurePrivateDir creates 0700 and fixes a looser mode", () => {
		const dir = join(tmp.dir, "a", "live");
		ensurePrivateDir(dir);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const loose = join(tmp.dir, "loose");
		mkdirSync(loose, { mode: 0o755 });
		ensurePrivateDir(loose);
		expect(statSync(loose).mode & 0o777).toBe(0o700);
	});

	test("writeSidecar is 0600, leaves no temp file and round-trips", () => {
		const path = join(tmp.dir, "s.json");
		const data = sidecar("s", "/x/s.sock", 1);
		writeSidecar(path, data);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(tmp.dir)).toEqual(["s.json"]);
		expect(readSidecar(path)).toEqual(data);
	});

	test("readSidecar returns undefined for missing or broken files", () => {
		expect(readSidecar(join(tmp.dir, "none.json"))).toBeUndefined();
		writeFileSync(join(tmp.dir, "bad.json"), "{");
		expect(readSidecar(join(tmp.dir, "bad.json"))).toBeUndefined();
	});
});

describe("staleness", () => {
	test("pidAlive", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(deadPid())).toBe(false);
	});

	test("live socket is not stale; dead socket and dead pid are", async () => {
		const live = join(tmp.dir, "live.sock");
		await listen(live);
		expect(await isStale(live, process.pid)).toBe(false);
		expect(await isStale(live, undefined)).toBe(false);
		expect(await isStale(live, deadPid())).toBe(true);
		const dead = join(tmp.dir, "dead.sock");
		await deadSocket(dead);
		expect(await isStale(dead, process.pid)).toBe(true);
		expect(await isStale(join(tmp.dir, "missing.sock"), process.pid)).toBe(true);
	});

	test("cleanStale removes dead sessions and keeps live ones", async () => {
		const dir = tmp.dir;
		// live: listening, sidecar with our pid
		await listen(join(dir, "live.sock"));
		writeSidecar(sidecarPathFor(dir, "live"), sidecar("live", join(dir, "live.sock"), process.pid));
		// dead: socket file, nobody listening
		await deadSocket(join(dir, "dead.sock"));
		writeSidecar(sidecarPathFor(dir, "dead"), sidecar("dead", join(dir, "dead.sock"), process.pid));
		// orphan: socket file, no sidecar
		await deadSocket(join(dir, "orphan.sock"));
		// gone: sidecar whose process died (its socket listens, but the pid is dead)
		await listen(join(dir, "gone.sock"));
		writeSidecar(sidecarPathFor(dir, "gone"), sidecar("gone", join(dir, "gone.sock"), deadPid()));

		const removed = await cleanStale(dir);
		expect(removed.sort()).toEqual(["dead", "gone", "orphan"]);
		expect(readdirSync(dir).sort()).toEqual(["live.json", "live.sock"]);
	});

	test("cleanStale follows a sidecar to a tmpdir fallback socket", async () => {
		const fallback = join(tmp.dir, "fb");
		ensurePrivateDir(fallback);
		const sock = join(fallback, "0123456789abcdef.sock");
		await deadSocket(sock);
		const live = join(tmp.dir, "live");
		ensurePrivateDir(live);
		writeSidecar(sidecarPathFor(live, "long"), sidecar("long", sock, process.pid));
		expect(await cleanStale(live)).toEqual(["long"]);
		expect(existsSync(sock)).toBe(false);
		expect(readdirSync(live)).toEqual([]);
	});

	test("cleanStale on a missing dir is a no-op", async () => {
		expect(await cleanStale(join(tmp.dir, "nope"))).toEqual([]);
	});
});
