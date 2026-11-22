import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LiveSettings {
	/** Off: claim the guard, but don't subscribe to parks or open a socket. */
	enabled: boolean;
	/** Socket and sidecar directory. */
	dir: string;
	/** Clients may act on pi (send, stop, set_model, …). */
	control: boolean;
}

/** The session's project, for the project control rule. */
export interface ProjectInfo {
	cwd: string;
	/** `ctx.isProjectTrusted()`. An untrusted project's file isn't read. */
	trusted: boolean;
}

/** `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, the same rule ask-user.json uses. */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	if (override) return override;
	return join(homedir(), ".pi", "agent");
}

/** `<agentDir>/pi-live.json`. */
export function getSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "pi-live.json");
}

/** `<cwd>/.pi/pi-live.json`. */
export function getProjectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "pi-live.json");
}

/**
 * Env first, then `<agentDir>/pi-live.json`, then defaults.
 *
 * A missing file is fine. A file that can't be read or isn't valid JSON throws
 * with the path in the message. Wrong-typed keys are ignored.
 *
 * `control` has one more source between env and the global file: a trusted
 * project's `<cwd>/.pi/pi-live.json` can turn it off (`true` there is ignored).
 * A bad project file is skipped with `warn`.
 */
export function loadSettings(
	env: NodeJS.ProcessEnv = process.env,
	filePath: string = getSettingsPath(env),
	project?: ProjectInfo,
	warn: (message: string) => void = () => {},
): LiveSettings {
	const file = readSettingsFile(filePath);

	let enabled = true;
	const envEnabled = env.PI_LIVE_ENABLED?.trim().toLowerCase();
	if (envEnabled === "0" || envEnabled === "false") enabled = false;
	else if (envEnabled === "1" || envEnabled === "true") enabled = true;
	else if (typeof file.enabled === "boolean") enabled = file.enabled;

	let dir = join(getAgentDir(env), "live");
	const envDir = env.PI_LIVE_DIR?.trim();
	if (envDir) dir = envDir;
	else if (typeof file.dir === "string" && file.dir.trim()) dir = file.dir.trim();

	let control = true;
	const envControl = env.PI_LIVE_CONTROL?.trim().toLowerCase();
	if (envControl === "0" || envControl === "false" || envControl === "off") control = false;
	else if (envControl === "1" || envControl === "true" || envControl === "on") control = true;
	else if (project?.trusted && projectControl(project.cwd, warn) === false) control = false;
	else if (typeof file.control === "boolean") control = file.control;

	return { enabled, dir, control };
}

function projectControl(cwd: string, warn: (message: string) => void): unknown {
	try {
		return readSettingsFile(getProjectSettingsPath(cwd)).control;
	} catch (error) {
		warn(`${(error as Error).message}; ignoring it`);
		return undefined;
	}
}

function readSettingsFile(filePath: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Failed to read pi-live settings at ${filePath}: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Failed to parse pi-live settings at ${filePath}: ${(error as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	return parsed as Record<string, unknown>;
}
