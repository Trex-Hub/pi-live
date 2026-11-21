import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, loadSettings } from "../src/settings";
import { tempDir } from "./helpers";

let tmp: ReturnType<typeof tempDir>;
let file: string;
beforeEach(() => {
	tmp = tempDir();
	file = join(tmp.dir, "pi-live.json");
});
afterEach(() => tmp.cleanup());

test("agent dir: PI_CODING_AGENT_DIR or ~/.pi/agent", () => {
	expect(getAgentDir({ PI_CODING_AGENT_DIR: "/a" })).toBe("/a");
	expect(getAgentDir({})).toBe(join(homedir(), ".pi", "agent"));
});

test("defaults: enabled, <agentDir>/live", () => {
	expect(loadSettings({ PI_CODING_AGENT_DIR: tmp.dir })).toEqual({ enabled: true, dir: join(tmp.dir, "live") });
});

test("file values apply; env wins over file", () => {
	writeFileSync(file, JSON.stringify({ enabled: false, dir: "/from/file" }));
	const env = { PI_CODING_AGENT_DIR: tmp.dir };
	expect(loadSettings(env)).toEqual({ enabled: false, dir: "/from/file" });
	expect(loadSettings({ ...env, PI_LIVE_ENABLED: "1", PI_LIVE_DIR: "/from/env" })).toEqual({ enabled: true, dir: "/from/env" });
});

test("PI_LIVE_ENABLED 0/false turn it off", () => {
	for (const v of ["0", "false", "FALSE"]) expect(loadSettings({ PI_CODING_AGENT_DIR: tmp.dir, PI_LIVE_ENABLED: v }).enabled).toBe(false);
});

test("wrong-typed keys are ignored; invalid JSON throws with the path", () => {
	writeFileSync(file, JSON.stringify({ enabled: "no", dir: 5 }));
	expect(loadSettings({ PI_CODING_AGENT_DIR: tmp.dir })).toEqual({ enabled: true, dir: join(tmp.dir, "live") });
	writeFileSync(file, "{");
	expect(() => loadSettings({ PI_CODING_AGENT_DIR: tmp.dir })).toThrow(file);
});
