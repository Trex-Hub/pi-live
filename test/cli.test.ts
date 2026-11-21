import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensurePrivateDir, writeSidecar } from "../src/paths";
import type { ParkRequest } from "../src/protocol";
import { Registry } from "../src/registry";
import { LiveServer } from "../src/server";
import { tempDir } from "./helpers";

const CLI = join(import.meta.dir, "..", "bin", "pi-live.ts");
let tmp: ReturnType<typeof tempDir>;
let server: LiveServer;
let registry: Registry;
let socketPath: string;

beforeEach(async () => {
	tmp = tempDir();
	ensurePrivateDir(tmp.dir);
	socketPath = join(tmp.dir, "s1.sock");
	registry = new Registry({
		opened: (item) => server.broadcast({ type: "item_opened", item }),
		closed: (id, outcome) => server.broadcast({ type: "item_closed", id, outcome }),
	});
	server = await LiveServer.listen({ socketPath, session: { id: "s1", cwd: "/work", pid: process.pid }, handler: registry });
	writeSidecar(join(tmp.dir, "s1.json"), {
		protocol: 1, sessionId: "s1", cwd: "/work", pid: process.pid, startedAt: "", socketPath,
	});
});

afterEach(() => {
	server.close();
	tmp.cleanup();
});

/** Run the CLI without blocking this process's event loop (the server lives here). */
function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, PI_LIVE_DIR: tmp.dir } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

test("ls lists sessions with liveness", async () => {
	const { code, stdout } = await cli("ls");
	expect(code).toBe(0);
	expect(stdout).toBe(`s1\talive\tpid ${process.pid}\t/work\n`);
});

test("answer by session id prints answer_result", async () => {
	const answers: unknown[] = [];
	const request: ParkRequest = {
		protocol: 1, id: "q1", owner: "o", kind: "k", title: "t", view: {},
		answer: (a) => {
			answers.push(a);
			return { status: "delivered" };
		},
		accept: () => {},
	};
	registry.park(request);
	const { code, stdout } = await cli("answer", "s1", "q1", '{"value":"Green"}');
	expect(JSON.parse(stdout)).toEqual({ type: "answer_result", reqId: "cli", id: "q1", status: "delivered" });
	expect(code).toBe(0);
	expect(answers).toEqual([{ value: "Green" }]);
});

test("answer to an unknown id exits 1 with not_found", async () => {
	const { code, stdout } = await cli("answer", socketPath, "nope", "1");
	expect(JSON.parse(stdout)).toMatchObject({ status: "not_found" });
	expect(code).toBe(1);
});

test("watch with no target picks the only live session and prints the welcome", async () => {
	const done = cli("watch");
	await new Promise((r) => setTimeout(r, 300));
	server.close();
	const { stdout } = await done;
	const lines = stdout.trim().split("\n").map((l) => JSON.parse(l));
	expect(lines[0]).toMatchObject({ type: "welcome", connId: "c1" });
	expect(lines.at(-1)).toEqual({ type: "goodbye", reason: "session_shutdown" });
});

test("bad usage exits 1", async () => {
	const { code, stderr } = await cli("frob");
	expect(code).toBe(1);
	expect(stderr).toContain("usage:");
});
