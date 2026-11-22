import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
	expect(loadSettings({ PI_CODING_AGENT_DIR: tmp.dir })).toEqual({ control: true, enabled: true, dir: join(tmp.dir, "live") });
});

test("file values apply; env wins over file", () => {
	writeFileSync(file, JSON.stringify({ enabled: false, dir: "/from/file" }));
	const env = { PI_CODING_AGENT_DIR: tmp.dir };
	expect(loadSettings(env)).toEqual({ control: true, enabled: false, dir: "/from/file" });
	expect(loadSettings({ ...env, PI_LIVE_ENABLED: "1", PI_LIVE_DIR: "/from/env" })).toEqual({ control: true, enabled: true, dir: "/from/env" });
});

test("PI_LIVE_ENABLED 0/false turn it off", () => {
	for (const v of ["0", "false", "FALSE"]) expect(loadSettings({ PI_CODING_AGENT_DIR: tmp.dir, PI_LIVE_ENABLED: v }).enabled).toBe(false);
});

test("wrong-typed keys are ignored; invalid JSON throws with the path", () => {
	writeFileSync(file, JSON.stringify({ enabled: "no", dir: 5 }));
	expect(loadSettings({ PI_CODING_AGENT_DIR: tmp.dir })).toEqual({ control: true, enabled: true, dir: join(tmp.dir, "live") });
	writeFileSync(file, "{");
	expect(() => loadSettings({ PI_CODING_AGENT_DIR: tmp.dir })).toThrow(file);
});

describe("control", () => {
	const env = () => ({ PI_CODING_AGENT_DIR: tmp.dir });
	let cwd: string;
	beforeEach(() => {
		cwd = join(tmp.dir, "proj");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
	});
	const project = (control: unknown) => writeFileSync(join(cwd, ".pi", "pi-live.json"), JSON.stringify({ control }));
	const load = (extra: Record<string, string> = {}, trusted = true, warn?: (m: string) => void) =>
		loadSettings({ ...env(), ...extra }, undefined, { cwd, trusted }, warn).control;

	test("default on", () => {
		expect(load()).toBe(true);
	});

	test("PI_LIVE_CONTROL: 0/false/off and 1/true/on; beats project and global", () => {
		project(false);
		writeFileSync(file, JSON.stringify({ control: false }));
		for (const v of ["1", "true", "ON"]) expect(load({ PI_LIVE_CONTROL: v })).toBe(true);
		writeFileSync(file, JSON.stringify({ control: true }));
		for (const v of ["0", "false", "Off"]) expect(load({ PI_LIVE_CONTROL: v })).toBe(false);
	});

	test("trusted project can turn it off, beating global", () => {
		writeFileSync(file, JSON.stringify({ control: true }));
		project(false);
		expect(load()).toBe(false);
	});

	test("untrusted project is ignored", () => {
		project(false);
		expect(load({}, false)).toBe(true);
	});

	test("project true doesn't turn it on", () => {
		writeFileSync(file, JSON.stringify({ control: false }));
		project(true);
		expect(load()).toBe(false);
	});

	test("global file", () => {
		writeFileSync(file, JSON.stringify({ control: false }));
		expect(load()).toBe(false);
	});

	test("bad project JSON is ignored with a warning; pi-live stays enabled", () => {
		writeFileSync(file, JSON.stringify({ control: false }));
		writeFileSync(join(cwd, ".pi", "pi-live.json"), "{");
		const warnings: string[] = [];
		const settings = loadSettings(env(), undefined, { cwd, trusted: true }, (m) => warnings.push(m));
		expect(settings).toMatchObject({ enabled: true, control: false });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(join(cwd, ".pi", "pi-live.json"));
	});
});
