// Chat out: turns pi's hooks into the chat messages of docs/protocol.md §4 and
// keeps the current picture for a chat client's welcome.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	ChatCommand,
	ChatMessage,
	ChatModel,
	ChatSnapshot,
	ChatState,
	ReplyBlock,
	RunningTool,
} from "./protocol";

/** At most one `reply` this often while an assistant message streams. */
export const REPLY_EVERY_MS = 50;
export const MAX_MODELS = 2000;
export const MAX_ARGUMENT_CHARS = 200;

/** pi's effort levels, lowest first. */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The pi hooks chat listens to. session_start/shutdown are handled by index.ts. */
export const CHAT_EVENTS = [
	"agent_start",
	"agent_settled",
	"turn_end",
	"input",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"session_compact",
	"session_compact_failed",
	"session_tree",
	"session_info_changed",
	"model_select",
	"thinking_level_select",
	"ui_prompt_start",
	"ui_prompt_end",
] as const;

export type ChatPi = Pick<ExtensionAPI, "getThinkingLevel" | "getSessionName" | "getCommands">;

// Hook payloads are read defensively; pi may send partial events.
type Loose = Record<string, any>;
type ModelLike = { provider: string; id: string; name?: string; reasoning?: boolean; thinkingLevelMap?: Record<string, unknown> };

export class Chat {
	private ctx: ExtensionContext;
	private working: boolean;
	private pending: ChatState["pending"] = [];
	private pendingSeq = 0;
	private waitingForUser: ChatState["waitingForUser"] = null;
	private tools = new Map<string, RunningTool>();
	private replyMessage: Loose | null = null;
	private lastReplyAt = 0;
	private replyTimer: ReturnType<typeof setTimeout> | undefined;
	private stateTimer: ReturnType<typeof setImmediate> | undefined;
	private entriesTimer: ReturnType<typeof setImmediate> | undefined;
	private entriesReplyDone = false;
	private models: ChatModel[];
	private commands: ChatCommand[];
	private disposed = false;

	constructor(
		private readonly pi: ChatPi,
		ctx: ExtensionContext,
		private readonly emit: (message: ChatMessage) => void,
	) {
		this.ctx = ctx;
		this.working = safe(() => !ctx.isIdle(), false);
		this.models = this.modelList();
		this.commands = this.commandList();
	}

	/** The whole current picture, for a chat client's welcome. */
	snapshot(): ChatSnapshot {
		return {
			state: this.state(),
			models: this.models,
			commands: this.commands,
			reply: { blocks: this.replyBlocks() },
			tools: [...this.tools.values()],
		};
	}

	/** Current state, as sent in `state`. */
	state(): ChatState {
		const c = this.ctx;
		const model = safe(() => c.model as ModelLike | undefined, undefined);
		let usage: ChatState["usage"] = null;
		const u = safe(() => c.getContextUsage(), undefined);
		if (u) usage = { tokens: u.tokens, window: u.contextWindow, percent: u.percent };
		const ctxEffort = safe(() => c.thinkingLevel ?? null, null);
		return {
			leafId: this.leafId(),
			model: model ? { provider: model.provider, id: model.id, name: model.name ?? model.id, reasoning: model.reasoning === true } : null,
			effort: safe(() => this.pi.getThinkingLevel() ?? ctxEffort, ctxEffort),
			efforts: efforts(model),
			working: this.working,
			pending: this.pending,
			usage,
			name: safe(() => this.pi.getSessionName() || null, null),
			waitingForUser: this.waitingForUser,
		};
	}

	/** Feed one pi hook. Never throws. */
	handle(name: string, event: unknown, ctx: ExtensionContext): void {
		if (this.disposed) return;
		this.ctx = ctx;
		const e = (event ?? {}) as Loose;
		switch (name) {
			case "agent_start":
				this.working = true;
				return this.scheduleState();
			case "agent_settled":
				this.working = false;
				this.pending = [];
				this.tools.clear(); // in case an end event was missed
				this.dropReply();
				this.refreshLists();
				return this.scheduleState();
			case "turn_end":
			case "session_info_changed":
			// After either select, send the current values: pi may clamp the level by itself.
			case "model_select":
			case "thinking_level_select":
				return this.scheduleState();
			case "input":
				if ((e.streamingBehavior === "steer" || e.streamingBehavior === "followUp") && typeof e.text === "string") {
					this.pending = [...this.pending, { id: `p${++this.pendingSeq}`, text: e.text, mode: e.streamingBehavior }];
					this.scheduleState();
				}
				return;
			case "message_start": {
				const m = e.message as Loose | undefined;
				if (m?.role === "assistant") {
					this.replyMessage = m;
					this.lastReplyAt = 0;
				} else if (m?.role === "user" && this.pending.length > 0) {
					const text = messageText(m.content).trim();
					const at = this.pending.findIndex((p) => p.text.trim() === text);
					if (at >= 0) {
						this.pending = this.pending.filter((_, i) => i !== at);
						this.scheduleState();
					}
				}
				return;
			}
			case "message_update":
				if (e.message?.role === "assistant") this.replyMessage = e.message;
				return this.scheduleReply();
			case "message_end": {
				const assistant = e.message?.role === "assistant";
				if (assistant) this.dropReply();
				return this.scheduleEntries(assistant);
			}
			case "tool_execution_start": {
				const argument = mainArgument(e.args);
				const tool: RunningTool = { callId: String(e.toolCallId), name: String(e.toolName ?? "tool"), ...(argument ? { argument } : {}) };
				this.tools.set(tool.callId, tool);
				return this.emit({ type: "tool", phase: "start", ...tool });
			}
			case "tool_execution_end": {
				const callId = String(e.toolCallId);
				this.tools.delete(callId);
				return this.emit({ type: "tool", phase: "end", callId, name: String(e.toolName ?? "tool"), isError: e.isError === true });
			}
			case "session_compact":
			case "session_tree":
				return this.scheduleEntries(false);
			case "session_compact_failed": {
				const text = typeof e.errorMessage === "string" && e.errorMessage ? e.errorMessage : "Compaction failed.";
				return this.emit({ type: "notice", level: "error", text });
			}
			case "ui_prompt_start":
				this.waitingForUser = { kind: String(e.kind ?? "custom"), title: typeof e.title === "string" ? e.title : null };
				return this.scheduleState();
			case "ui_prompt_end":
				this.waitingForUser = null;
				return this.scheduleState();
		}
	}

	/** Send a notice to chat clients. */
	notice(level: "info" | "warning" | "error", text: string): void {
		if (!this.disposed) this.emit({ type: "notice", level, text });
	}

	/** Send `state` soon (coalesced). */
	scheduleState(): void {
		if (this.stateTimer || this.disposed) return;
		this.stateTimer = setImmediate(() => {
			this.stateTimer = undefined;
			if (!this.disposed) this.emit({ type: "state", ...this.state() });
		});
		this.stateTimer.unref?.();
	}

	/** Stop all timers; nothing is sent after this. */
	dispose(): void {
		this.disposed = true;
		if (this.replyTimer) clearTimeout(this.replyTimer);
		if (this.stateTimer) clearImmediate(this.stateTimer);
		if (this.entriesTimer) clearImmediate(this.entriesTimer);
		this.replyTimer = this.stateTimer = this.entriesTimer = undefined;
	}

	private leafId(): string | null {
		return safe(() => this.ctx.sessionManager.getLeafId() ?? null, null);
	}

	/** pi writes the session file after the handlers run, so tell clients one tick later. */
	private scheduleEntries(replyDone: boolean): void {
		this.entriesReplyDone = this.entriesReplyDone || replyDone;
		if (this.entriesTimer || this.disposed) return;
		this.entriesTimer = setImmediate(() => {
			this.entriesTimer = undefined;
			if (this.disposed) return;
			const done = this.entriesReplyDone;
			this.entriesReplyDone = false;
			this.emit({ type: "entries", leafId: this.leafId(), replyDone: done });
			this.emit({ type: "state", ...this.state() });
		});
		this.entriesTimer.unref?.();
	}

	private scheduleReply(): void {
		if (this.replyTimer || this.disposed) return;
		const wait = Math.max(0, this.lastReplyAt + REPLY_EVERY_MS - Date.now());
		if (wait === 0) return this.flushReply();
		this.replyTimer = setTimeout(() => this.flushReply(), wait);
		this.replyTimer.unref?.();
	}

	private flushReply(): void {
		if (this.replyTimer) clearTimeout(this.replyTimer);
		this.replyTimer = undefined;
		if (!this.replyMessage || this.disposed) return;
		this.lastReplyAt = Date.now();
		const blocks = this.replyBlocks();
		if (blocks.length > 0) this.emit({ type: "reply", blocks });
	}

	/** The assistant message ended: forget it and any throttled reply. */
	private dropReply(): void {
		this.replyMessage = null;
		if (this.replyTimer) clearTimeout(this.replyTimer);
		this.replyTimer = undefined;
	}

	private replyBlocks(): ReplyBlock[] {
		const content = this.replyMessage?.content;
		const blocks: ReplyBlock[] = [];
		for (const block of Array.isArray(content) ? content : []) {
			if (block?.type === "text" && typeof block.text === "string" && block.text !== "") blocks.push({ kind: "text", text: block.text });
			else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking !== "") {
				blocks.push({ kind: "thinking", text: block.thinking });
			}
		}
		return blocks;
	}

	/** pi has no event for model or command list changes; check after each run. */
	private refreshLists(): void {
		const models = this.modelList();
		if (JSON.stringify(models) !== JSON.stringify(this.models)) {
			this.models = models;
			this.emit({ type: "models", list: models });
		}
		const commands = this.commandList();
		if (JSON.stringify(commands) !== JSON.stringify(this.commands)) {
			this.commands = commands;
			this.emit({ type: "commands", list: commands });
		}
	}

	private modelList(): ChatModel[] {
		return safe(() => {
			const scoped = this.ctx.scopedModels ?? [];
			const models = (scoped.length > 0 ? scoped.map((s) => s.model) : this.ctx.modelRegistry.getAvailable()) as ModelLike[];
			return models.slice(0, MAX_MODELS).map((m) => ({
				provider: m.provider,
				id: m.id,
				name: m.name ?? m.id,
				reasoning: m.reasoning === true,
				efforts: efforts(m),
			}));
		}, []);
	}

	private commandList(): ChatCommand[] {
		return safe(
			() =>
				this.pi.getCommands().map((c) => ({
					name: c.name,
					...(c.description ? { description: c.description } : {}),
					source: c.source,
				})),
			[],
		);
	}
}

/** Effort levels a model takes: none without a model, "off" only if it doesn't reason. */
export function efforts(model: ModelLike | undefined): string[] {
	if (!model) return [];
	if (!model.reasoning) return ["off"];
	return LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** A tool call's main argument (command, path, …): first non-empty line, at most 200 chars. */
export function mainArgument(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	for (const key of ["command", "path", "file_path", "filePath", "pattern", "query", "url", "name"]) {
		const v = a[key];
		if (typeof v === "string" && v) return cut(firstNonEmptyLine(v));
	}
	for (const v of Object.values(a)) if (typeof v === "string" && v) return cut(firstNonEmptyLine(v));
	return "";
}

function firstNonEmptyLine(text: string): string {
	return (text.split("\n").find((l) => l.trim()) ?? "").trim();
}

function cut(line: string): string {
	return line.length <= MAX_ARGUMENT_CHARS ? line : `${line.slice(0, MAX_ARGUMENT_CHARS - 1)}…`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (b && typeof b === "object" && b.type === "text" ? String(b.text ?? "") : "")).join("\n");
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}
