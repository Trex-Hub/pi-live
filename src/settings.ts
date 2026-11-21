import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LiveSettings {
	/** Off: claim the guard, but don't subscribe to parks or open a socket. */
	enabled: boolean;
	/** Socket and sidecar directory. */
	dir: string;
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

/**
 * Env first, then `<agentDir>/pi-live.json`, then defaults.
 *
 * A missing file is fine. A file that can't be read or isn't valid JSON throws
 * with the path in the message. Wrong-typed keys are ignored.
 */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, filePath: string = getSettingsPath(env)): LiveSettings {
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

	return { enabled, dir };
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
