// pi-live: a per-session local socket that lets outside clients see and answer
// what this pi session is waiting on. See docs/protocol.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { runAction } from "./src/actions";
import { CHAT_EVENTS, Chat } from "./src/chat";
import {
	cleanStale,
	ensurePrivateDir,
	type FileId,
	fileId,
	isStale,
	readSidecar,
	removeFile,
	removeIfOurs,
	sidecarPathFor,
	socketPathFor,
	writeSidecar,
} from "./src/paths";
import {
	CHANNEL_CLOSED,
	CHANNEL_PARK,
	CHANNEL_READY,
	CHANNEL_WHO,
	type ReadyInfo,
	type SessionMode,
	type ShutdownReason,
} from "./src/protocol";
import { Registry } from "./src/registry";
import { LiveServer } from "./src/server";
import { loadSettings } from "./src/settings";

/** Kept in sync with package.json (tested). */
export const PKG_VERSION = "0.2.0";

/** Process-wide single-instance key, shared by every copy of pi-live. */
export const GUARD_KEY = Symbol.for("pi-live.host.v1");

interface Running {
	ready: ReadyInfo;
	server: LiveServer;
	registry: Registry;
	chat: Chat;
	sidecarPath: string;
	sidecarId: FileId | undefined;
	unsubscribe: Array<() => void>;
	onExit: () => void;
}

export default function piLive(pi: ExtensionAPI): void {
	const g = globalThis as Record<symbol, unknown>;
	if (g[GUARD_KEY]) return; // another copy owns the door; this copy registers nothing
	const claim = { version: PKG_VERSION };
	g[GUARD_KEY] = claim;

	let ctx: ExtensionContext | undefined;
	let running: Running | undefined;
	let starting: Promise<void> | undefined;

	const log = (message: string) => {
		const text = `[pi-live] ${message}`;
		try {
			if (ctx?.hasUI && ctx.mode === "tui") {
				ctx.ui.notify(text, "warning");
				return;
			}
		} catch {
			// Stale ctx; fall through.
		}
		console.error(text);
	};

	async function start(c: ExtensionContext): Promise<void> {
		if (c.mode !== "tui" && c.mode !== "rpc") return;
		const mode: SessionMode = c.mode;

		let settings: ReturnType<typeof loadSettings>;
		try {
			const cwd = c.sessionManager.getCwd();
			settings = loadSettings(process.env, undefined, { cwd, trusted: safe(() => c.isProjectTrusted() === true, false) }, log);
		} catch (error) {
			log(`${(error as Error).message}; off for this session`);
			return;
		}
		if (!settings.enabled) return;

		const sessionId = c.sessionManager.getSessionId();
		const sessionFile = c.sessionManager.getSessionFile();
		const cwd = c.sessionManager.getCwd();
		const terminal = process.env.PI_LIVE_TERMINAL?.trim() || process.env.HC_TERMINAL_ID?.trim() || undefined;
		const { dir } = settings;
		const socketPath = socketPathFor(dir, sessionId);
		const sidecarPath = sidecarPathFor(dir, sessionId);

		ensurePrivateDir(dir);
		if (process.platform !== "win32" && dirname(socketPath) !== dir) ensurePrivateDir(dirname(socketPath));
		await cleanStale(dir);

		// Our own path may still exist (e.g. a tmpdir fallback without a sidecar).
		if (process.platform !== "win32" && fileId(socketPath)) {
			if (!(await isStale(socketPath, readSidecar(sidecarPath)?.pid))) {
				log(`session ${sessionId} is already served by another pi at ${socketPath}; off for this session`);
				return;
			}
			removeFile(socketPath);
		}

		let server: LiveServer | undefined;
		const chat = new Chat(pi, c, (message) => server?.broadcastChat(message));
		const registry = new Registry(
			{
				opened: (item) => server?.broadcast({ type: "item_opened", item }),
				closed: (id, outcome) => server?.broadcast({ type: "item_closed", id, outcome }),
			},
			log,
		);
		try {
			server = await LiveServer.listen({
				socketPath,
				session: { id: sessionId, file: sessionFile, cwd, pid: process.pid, mode, ...(terminal ? { terminal } : {}) },
				handler: {
					items: () => registry.items(),
					answer: (id, answer, from, reply) => registry.answer(id, answer, from, reply),
					sessionName: () => safe(() => pi.getSessionName() || undefined, undefined),
					chatSnapshot: () => chat.snapshot(),
					action: (action, _from, reply) => {
						void runAction(action, { pi, ctx: () => ctx, changed: () => chat.scheduleState() })
							.then(reply)
							.catch((error) => log(`action reply failed: ${(error as Error).message}`));
					},
				},
				log,
				version: PKG_VERSION,
				control: settings.control,
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "EADDRINUSE") {
				log(`session ${sessionId} is already served by another pi at ${socketPath}; off for this session`);
			} else {
				log(`could not listen on ${socketPath}: ${(error as Error).message}; off for this session`);
			}
			chat.dispose();
			return;
		}

		let sidecarId: FileId | undefined;
		try {
			writeSidecar(sidecarPath, {
				protocol: 1,
				sessionId,
				sessionFile,
				cwd,
				pid: process.pid,
				startedAt: new Date().toISOString(),
				socketPath,
				mode,
				...(terminal ? { terminal } : {}),
				version: PKG_VERSION,
			});
			sidecarId = fileId(sidecarPath);
		} catch (error) {
			log(`could not write ${sidecarPath}: ${(error as Error).message}`);
		}

		const ready: ReadyInfo = { protocol: 1, sessionId, socketPath };
		const live = server;
		// Backstop for an exit without session_shutdown. A hard kill is left to stale cleanup.
		const onExit = () => {
			removeIfOurs(socketPath, live.socketId);
			removeIfOurs(sidecarPath, sidecarId);
		};
		process.on("exit", onExit);

		const unsubscribe = [
			pi.events.on(CHANNEL_PARK, (data) => {
				try {
					registry.park(data);
				} catch (error) {
					log(`park failed: ${(error as Error).message}`);
				}
			}),
			pi.events.on(CHANNEL_WHO, (data) => {
				const reply = (data as { reply?: unknown } | null)?.reply;
				if (typeof reply !== "function") return;
				try {
					reply(ready);
				} catch (error) {
					log(`pi-live:who reply threw: ${(error as Error).message}`);
				}
			}),
		];
		running = { ready, server, registry, chat, sidecarPath, sidecarId, unsubscribe, onExit };
		pi.events.emit(CHANNEL_READY, ready);
	}

	function stop(reason: ShutdownReason | undefined): void {
		const r = running;
		if (!r) return;
		running = undefined;
		for (const off of r.unsubscribe) off();
		r.chat.dispose();
		r.registry.closeAll({ by: "shutdown" });
		r.server.close(reason);
		removeIfOurs(r.sidecarPath, r.sidecarId);
		process.off("exit", r.onExit);
		pi.events.emit(CHANNEL_CLOSED, { sessionId: r.ready.sessionId });
	}

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		starting = start(c).catch((error) => log(`could not start: ${(error as Error).message}`));
		await starting;
	});

	const on = pi.on as (event: string, handler: (event: unknown, c: ExtensionContext) => void) => void;
	for (const name of CHAT_EVENTS) {
		on(name, (event, c) => {
			try {
				running?.chat.handle(name, event, c);
			} catch (error) {
				log(`${name} failed: ${(error as Error).message}`);
			}
		});
	}

	pi.on("session_shutdown", async (event) => {
		await starting;
		starting = undefined;
		try {
			stop(event?.reason);
		} catch (error) {
			log(`shutdown failed: ${(error as Error).message}`);
		}
		ctx = undefined;
		if (g[GUARD_KEY] === claim) delete g[GUARD_KEY];
	});
}

/** `fn()`, or `fallback` if it throws (pi APIs on a stale or partial ctx). */
function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}
