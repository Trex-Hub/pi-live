import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sidecar } from "./protocol";

/** Unix socket paths longer than this fall back to tmpdir (macOS allows 104 bytes, Linux 108). */
export const MAX_SOCKET_PATH_BYTES = 100;
export const PROBE_TIMEOUT_MS = 200;

/** Where the session's socket lives. Long paths fall back to `<tmpdir>/pi-live-<uid>/<hash>.sock`. */
export function socketPathFor(dir: string, sessionId: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-live-${sessionId}`;
	const path = join(dir, `${sessionId}.sock`);
	if (Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES) return path;
	const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return join(fallbackDir(), `${hash}.sock`);
}

/** `<tmpdir>/pi-live-<uid>`, used for sockets whose normal path is too long. */
export function fallbackDir(): string {
	return join(tmpdir(), `pi-live-${process.getuid?.() ?? "user"}`);
}

/** The sidecar always sits in the live dir, so `ls`-style scans find every session. */
export function sidecarPathFor(dir: string, sessionId: string): string {
	return join(dir, `${sessionId}.json`);
}

/** Create `dir` with mode 0700 and make sure it is 0700 (fails if someone else owns it). */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(dir, 0o700);
}

/** Write the sidecar atomically (temp file, then rename) with mode 0600. */
export function writeSidecar(path: string, sidecar: Sidecar): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(sidecar)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export function readSidecar(path: string): Sidecar | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Sidecar) : undefined;
	} catch {
		return undefined;
	}
}

/** Unlink, ignoring a missing file. */
export function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Identifies one file on disk, so we only unlink a path that is still ours. */
export interface FileId {
	dev: number;
	ino: number;
}

export function fileId(path: string): FileId | undefined {
	try {
		const { dev, ino } = statSync(path);
		return { dev, ino };
	} catch {
		return undefined;
	}
}

/** Unlink `path` only if it is still the file identified by `id`. Never throws. */
export function removeIfOurs(path: string, id: FileId | undefined): void {
	if (!id) return;
	const now = fileId(path);
	if (!now || now.dev !== id.dev || now.ino !== id.ino) return;
	try {
		unlinkSync(path);
	} catch {
		// Gone or not removable; nothing to do.
	}
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Try to connect. "refused" means ECONNREFUSED/ENOENT; "unknown" is a timeout or any other error. */
export function probeSocket(path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<"live" | "refused" | "unknown"> {
	return new Promise((resolve) => {
		const socket = connect(path);
		const done = (result: "live" | "refused" | "unknown") => {
			clearTimeout(timer);
			socket.destroy();
			resolve(result);
		};
		const timer = setTimeout(() => done("unknown"), timeoutMs);
		socket.once("connect", () => done("live"));
		socket.once("error", (error: NodeJS.ErrnoException) =>
			done(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "refused" : "unknown"),
		);
	});
}

/** A socket is stale if its sidecar's pid is dead, or nothing accepts on it. */
export async function isStale(socketPath: string, pid: number | undefined): Promise<boolean> {
	if (typeof pid === "number" && !pidAlive(pid)) return true;
	const result = await probeSocket(socketPath);
	if (result === "live") return false;
	if (result === "refused") return true;
	return typeof pid !== "number";
}

/**
 * Remove stale sockets and sidecars from `dir`. Each session is found by its
 * `*.sock` or `*.json`; the sidecar's `socketPath` covers tmpdir fallbacks.
 * Returns the session ids that were removed.
 */
export async function cleanStale(dir: string): Promise<string[]> {
	if (process.platform === "win32") return [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const ids = new Set<string>();
	for (const name of names) {
		if (name.endsWith(".sock")) ids.add(name.slice(0, -".sock".length));
		else if (name.endsWith(".json")) ids.add(name.slice(0, -".json".length));
	}
	const removed: string[] = [];
	for (const id of ids) {
		const sidecarPath = sidecarPathFor(dir, id);
		const sidecar = readSidecar(sidecarPath);
		const localSocket = join(dir, `${id}.sock`);
		const socketPath = typeof sidecar?.socketPath === "string" ? sidecar.socketPath : localSocket;
		if (!(await isStale(socketPath, typeof sidecar?.pid === "number" ? sidecar.pid : undefined))) continue;
		try {
			removeFile(localSocket);
			if (socketPath !== localSocket && socketPath.endsWith(".sock")) removeFile(socketPath);
			removeFile(sidecarPath);
			removed.push(id);
		} catch {
			// Not ours to remove (permissions); leave it.
		}
	}
	return removed;
}
