import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Chat, efforts, LEVELS, MAX_MODELS, mainArgument, REPLY_EVERY_MS } from "../src/chat";
import type { ChatMessage } from "../src/protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tickOnce = () => new Promise((r) => setImmediate(r));

interface State {
	idle: boolean;
	leaf: string | null;
	model: FakeModel | undefined;
	usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	level: string | undefined;
	name: string | undefined;
	scoped: Array<{ model: FakeModel }>;
	available: FakeModel[];
	commands: unknown[];
}
type FakeModel = { provider: string; id: string; name?: string; reasoning?: boolean; input?: unknown; thinkingLevelMap?: Record<string, unknown> };

/** A fake pi + ctx whose values the test can change, and a Chat that records what it sends. */
function setup(init: (s: State) => void = () => {}) {
	const s: State = {
		idle: true,
		leaf: "l0",
		model: undefined,
		usage: undefined,
		level: "off",
		name: undefined,
		scoped: [],
		available: [{ provider: "p", id: "m1" }],
		commands: [{ name: "review", description: "Review code", source: "prompt", sourceInfo: {} }],
	};
	init(s);
	const ctx = {
		isIdle: () => s.idle,
		sessionManager: { getLeafId: () => s.leaf },
		get model() {
			return s.model;
		},
		getContextUsage: () => s.usage,
		get scopedModels() {
			return s.scoped;
		},
		modelRegistry: { getAvailable: () => s.available },
	};
	const pi = {
		getThinkingLevel: () => s.level,
		getSessionName: () => s.name,
		getCommands: () => s.commands,
	};
	const sent: ChatMessage[] = [];
	const chat = new Chat(pi as never, ctx as never, (m) => sent.push(m));
	const fire = (name: string, event: unknown = {}) => chat.handle(name, event, ctx as never);
	const of = <T extends ChatMessage["type"]>(type: T) => sent.filter((m) => m.type === type) as Extract<ChatMessage, { type: T }>[];
	return { s, ctx, chat, sent, fire, of };
}

const assistant = (...content: unknown[]) => ({ message: { role: "assistant", content } });

describe("state", () => {
	test("coalesced: several changes in one tick send one whole state", async () => {
		const { fire, of } = setup();
		fire("agent_start");
		fire("turn_end");
		fire("model_select");
		expect(of("state")).toHaveLength(0);
		await tickOnce();
		expect(of("state")).toHaveLength(1);
	});

	test("fields come from pi and ctx", async () => {
		const { s, chat, fire, of } = setup();
		s.model = { provider: "p", id: "m", reasoning: true };
		s.usage = { tokens: 10, contextWindow: 100, percent: 10 };
		s.level = "high";
		s.name = "my session";
		s.leaf = "L7";
		fire("agent_start");
		await tickOnce();
		expect(of("state")[0]).toEqual({
			type: "state",
			leafId: "L7",
			model: { provider: "p", id: "m", name: "m", reasoning: true, input: ["text"] },
			effort: "high",
			efforts: ["off", "minimal", "low", "medium", "high"],
			working: true,
			pending: [],
			usage: { tokens: 10, window: 100, percent: 10 },
			name: "my session",
			waitingForUser: null,
		});
		s.model = undefined;
		s.usage = undefined;
		s.name = "";
		s.leaf = null;
		expect(chat.state()).toMatchObject({ leafId: null, model: null, efforts: [], usage: null, name: null });
	});

	test("working starts from ctx.isIdle and follows agent_start / agent_settled", async () => {
		const a = setup();
		expect(a.chat.state().working).toBe(false);
		expect(setup((s) => (s.idle = false)).chat.state().working).toBe(true);
		a.fire("agent_start");
		expect(a.chat.state().working).toBe(true);
		a.fire("agent_settled");
		expect(a.chat.state().working).toBe(false);
	});

	test("waitingForUser from ui_prompt_start until ui_prompt_end; title null if none", async () => {
		const { chat, fire, of } = setup();
		fire("ui_prompt_start", { kind: "confirm", title: "Run it?" });
		expect(chat.state().waitingForUser).toEqual({ kind: "confirm", title: "Run it?" });
		await tickOnce();
		expect(of("state").at(-1)?.waitingForUser).toEqual({ kind: "confirm", title: "Run it?" });
		fire("ui_prompt_end", { kind: "confirm" });
		expect(chat.state().waitingForUser).toBeNull();
		fire("ui_prompt_start", { kind: "input" });
		expect(chat.state().waitingForUser).toEqual({ kind: "input", title: null });
	});

	test("model, effort and name changes send state", async () => {
		const { s, fire, of } = setup();
		for (const ev of ["model_select", "thinking_level_select", "session_info_changed", "turn_end"]) {
			s.level = ev;
			fire(ev);
			await tickOnce();
			expect(of("state").at(-1)?.effort).toBe(ev);
		}
	});
});

describe("efforts and models", () => {
	test("efforts: none without a model, off for non-reasoning, thinkingLevelMap rules", () => {
		expect(efforts(undefined)).toEqual([]);
		expect(efforts({ provider: "p", id: "m" })).toEqual(["off"]);
		expect(efforts({ provider: "p", id: "m", reasoning: true })).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(efforts({ provider: "p", id: "m", reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "x", max: null } })).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	test("models: scoped if set, else available; name falls back to id; capped", () => {
		const a = setup();
		expect(a.chat.snapshot().models).toEqual([{ provider: "p", id: "m1", name: "m1", reasoning: false, input: ["text"], efforts: ["off"] }]);
		const many = Array.from({ length: MAX_MODELS + 5 }, (_, i) => ({ provider: "p", id: `m${i}` }));
		const scoped = setup((s) => {
			s.scoped = [{ model: { provider: "q", id: "s", name: "Scoped", reasoning: true } }];
			s.available = many;
		});
		expect(scoped.chat.snapshot().models).toEqual([
			{ provider: "q", id: "s", name: "Scoped", reasoning: true, input: ["text"], efforts: ["off", "minimal", "low", "medium", "high"] },
		]);
		expect(setup((s) => (s.available = many)).chat.snapshot().models).toHaveLength(MAX_MODELS);
	});

	test("input: from the model, only text and image kept, [\"text\"] when missing or unusable", () => {
		const vision = { provider: "p", id: "v", input: ["text", "image"] };
		const odd = { provider: "p", id: "o", input: ["audio", "image", 3] };
		const none = { provider: "p", id: "n", input: [] };
		const bad = { provider: "p", id: "b", input: "image" };
		const a = setup((s) => (s.available = [vision, odd, none, bad, { provider: "p", id: "x" }]));
		expect(a.chat.snapshot().models.map((m) => m.input)).toEqual([["text", "image"], ["image"], ["text"], ["text"], ["text"]]);
		const b = setup((s) => (s.model = vision));
		expect(b.chat.state().model?.input).toEqual(["text", "image"]);
		const c = setup((s) => (s.model = odd));
		expect(c.chat.state().model?.input).toEqual(["image"]);
	});

	test("models and commands: resent on agent_settled only if different", () => {
		const { s, chat, fire, of } = setup();
		expect(chat.snapshot().commands).toEqual([{ name: "review", description: "Review code", source: "prompt" }]);
		fire("agent_settled");
		expect(of("models")).toHaveLength(0);
		expect(of("commands")).toHaveLength(0);
		s.commands = [...s.commands, { name: "deploy", source: "extension", sourceInfo: {} }];
		s.available = [...s.available, { provider: "p", id: "m2" }];
		fire("agent_settled");
		expect(of("commands")[0]?.list.map((c) => c.name)).toEqual(["review", "deploy"]);
		expect(of("commands")[0]?.list[1]).toEqual({ name: "deploy", source: "extension" });
		expect(of("models")[0]?.list.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(chat.snapshot().commands).toHaveLength(2);
		fire("agent_settled");
		expect(of("commands")).toHaveLength(1);
		expect(of("models")).toHaveLength(1);
	});
});

describe("reply", () => {
	test("throttled: 300 quick updates send at most a few replies, the last one whole", async () => {
		const { fire, of } = setup();
		fire("message_start", assistant());
		let text = "";
		for (let i = 0; i < 300; i++) {
			text += "x";
			fire("message_update", assistant({ type: "text", text }));
		}
		await sleep(REPLY_EVERY_MS * 2);
		const replies = of("reply");
		expect(replies.length).toBeGreaterThanOrEqual(1);
		expect(replies.length).toBeLessThanOrEqual(3);
		expect(replies.at(-1)?.blocks).toEqual([{ kind: "text", text }]);
	});

	test("at most one reply every 50 ms while streaming", async () => {
		const { fire, of } = setup();
		fire("message_start", assistant());
		const startedAt = Date.now();
		let i = 0;
		while (Date.now() - startedAt < 300) {
			fire("message_update", assistant({ type: "text", text: `t${i++}` }));
			await sleep(2);
		}
		await sleep(REPLY_EVERY_MS * 2);
		expect(of("reply").length).toBeLessThanOrEqual(Math.ceil(300 / REPLY_EVERY_MS) + 2);
		expect(of("reply").at(-1)?.blocks).toEqual([{ kind: "text", text: `t${i - 1}` }]);
	});

	test("blocks keep order; empty and other blocks are left out; no blocks, no reply", async () => {
		const { fire, of } = setup();
		fire("message_start", assistant());
		fire("message_update", assistant({ type: "text", text: "" }, { type: "toolCall", name: "bash" }));
		expect(of("reply")).toHaveLength(0);
		await sleep(REPLY_EVERY_MS + 10);
		fire(
			"message_update",
			assistant({ type: "thinking", thinking: "hmm" }, { type: "text", text: "a" }, { type: "thinking", thinking: "" }, { type: "text", text: "b" }),
		);
		await sleep(REPLY_EVERY_MS + 10);
		expect(of("reply").at(-1)?.blocks).toEqual([
			{ kind: "thinking", text: "hmm" },
			{ kind: "text", text: "a" },
			{ kind: "text", text: "b" },
		]);
	});

	test("message_end drops a throttled reply; entries one tick later with replyDone and the leaf, then state", async () => {
		const { s, fire, sent, of } = setup();
		fire("message_start", assistant());
		fire("message_update", assistant({ type: "text", text: "a" }));
		fire("message_update", assistant({ type: "text", text: "ab" })); // throttled
		s.leaf = "L9";
		fire("message_end", assistant({ type: "text", text: "abc" }));
		expect(of("entries")).toHaveLength(0);
		await tickOnce();
		const at = sent.findIndex((m) => m.type === "entries");
		expect(sent[at]).toEqual({ type: "entries", leafId: "L9", replyDone: true });
		expect(sent[at + 1]?.type).toBe("state");
		await sleep(REPLY_EVERY_MS + 10);
		expect(of("reply").map((r) => r.blocks[0]?.text)).toEqual(["a"]);
	});

	test("entries: other message_end, session_compact and session_tree send replyDone false; coalesced per tick", async () => {
		const { fire, of } = setup();
		for (const ev of ["session_compact", "session_tree"]) {
			fire(ev);
			await tickOnce();
		}
		fire("message_end", { message: { role: "user", content: "hi" } });
		fire("message_end", { message: { role: "toolResult" } });
		await tickOnce();
		expect(of("entries").map((e) => e.replyDone)).toEqual([false, false, false]);
		fire("message_end", { message: { role: "user" } });
		fire("message_end", assistant());
		await tickOnce();
		expect(of("entries").at(-1)?.replyDone).toBe(true);
		expect(of("entries")).toHaveLength(4);
	});

	test("agent_settled forgets the reply", () => {
		const { chat, fire } = setup();
		fire("message_start", assistant());
		fire("message_update", assistant({ type: "text", text: "so far" }));
		expect(chat.snapshot().reply.blocks).toEqual([{ kind: "text", text: "so far" }]);
		fire("agent_settled");
		expect(chat.snapshot().reply.blocks).toEqual([]);
	});
});

describe("tools", () => {
	test("start and end messages; the snapshot holds the running ones, oldest first", () => {
		const { chat, fire, of } = setup();
		fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "bun test" } });
		fire("tool_execution_start", { toolCallId: "c2", toolName: "read", args: { path: "/a" } });
		fire("tool_execution_start", { toolCallId: 3, args: {} });
		expect(chat.snapshot().tools).toEqual([
			{ callId: "c1", name: "bash", argument: "bun test" },
			{ callId: "c2", name: "read", argument: "/a" },
			{ callId: "3", name: "tool" },
		]);
		fire("tool_execution_end", { toolCallId: "c1", toolName: "bash", isError: true });
		fire("tool_execution_end", { toolCallId: "c2", toolName: "read" });
		expect(of("tool")).toEqual([
			{ type: "tool", phase: "start", callId: "c1", name: "bash", argument: "bun test" },
			{ type: "tool", phase: "start", callId: "c2", name: "read", argument: "/a" },
			{ type: "tool", phase: "start", callId: "3", name: "tool" },
			{ type: "tool", phase: "end", callId: "c1", name: "bash", isError: true },
			{ type: "tool", phase: "end", callId: "c2", name: "read", isError: false },
		]);
		expect(chat.snapshot().tools).toEqual([{ callId: "3", name: "tool" }]);
		fire("agent_settled"); // a missed end event
		expect(chat.snapshot().tools).toEqual([]);
	});

	test("main argument: preferred keys, first non-empty line, cut to 200", () => {
		expect(mainArgument({ timeout: 5, command: "\n  ls -la  \nmore" })).toBe("ls -la");
		expect(mainArgument({ other: "x", path: "/p" })).toBe("/p");
		expect(mainArgument({ other: "x" })).toBe("x");
		expect(mainArgument({ n: 1 })).toBe("");
		expect(mainArgument(null)).toBe("");
		const long = mainArgument({ command: "a".repeat(500) });
		expect(long).toHaveLength(200);
		expect(long.endsWith("…")).toBe(true);
		expect(mainArgument({ command: "a".repeat(200) })).toBe("a".repeat(200));
	});
});

describe("pending", () => {
	test("steer and followUp inputs are pending until their user message starts; idle input is not", async () => {
		const { chat, fire } = setup();
		fire("input", { text: "now", source: "interactive" });
		fire("input", { text: " steer me ", streamingBehavior: "steer" });
		fire("input", { text: "later", streamingBehavior: "followUp" });
		expect(chat.state().pending).toEqual([
			{ id: "p1", text: " steer me ", mode: "steer" },
			{ id: "p2", text: "later", mode: "followUp" },
		]);
		fire("message_start", { message: { role: "user", content: [{ type: "text", text: "steer me" }] } });
		expect(chat.state().pending.map((p) => p.id)).toEqual(["p2"]);
		fire("message_start", { message: { role: "user", content: "unrelated" } });
		expect(chat.state().pending.map((p) => p.id)).toEqual(["p2"]);
		fire("agent_settled");
		expect(chat.state().pending).toEqual([]);
	});

	test("the same text twice leaves one at a time", () => {
		const { chat, fire } = setup();
		fire("input", { text: "go", streamingBehavior: "steer" });
		fire("input", { text: "go", streamingBehavior: "steer" });
		fire("message_start", { message: { role: "user", content: "go" } });
		expect(chat.state().pending.map((p) => p.id)).toEqual(["p2"]);
		fire("message_start", { message: { role: "user", content: "go" } });
		expect(chat.state().pending).toEqual([]);
	});
});

describe("notices and lifetime", () => {
	test("compaction failure is an error notice", () => {
		const { fire, of } = setup();
		fire("session_compact_failed", { errorMessage: "Nothing to compact" });
		fire("session_compact_failed", { aborted: true });
		expect(of("notice")).toEqual([
			{ type: "notice", level: "error", text: "Nothing to compact" },
			{ type: "notice", level: "error", text: "Compaction failed." },
		]);
	});

	test("dispose: nothing is sent afterwards, pending timers included", async () => {
		const { chat, fire, sent } = setup();
		fire("agent_start");
		fire("message_start", assistant());
		fire("message_update", assistant({ type: "text", text: "a" }));
		fire("message_update", assistant({ type: "text", text: "ab" }));
		fire("message_end", assistant());
		const before = sent.length;
		chat.dispose();
		fire("agent_settled");
		await sleep(REPLY_EVERY_MS + 10);
		expect(sent).toHaveLength(before);
	});

	test("broken pi APIs don't throw", () => {
		const sent: ChatMessage[] = [];
		const boom = () => {
			throw new Error("stale");
		};
		const ctx = { isIdle: boom, sessionManager: { getLeafId: boom }, getContextUsage: boom, modelRegistry: { getAvailable: boom } };
		Object.defineProperty(ctx, "model", { get: boom });
		const chat = new Chat({ getThinkingLevel: boom, getSessionName: boom, getCommands: boom } as never, ctx as never, (m) => sent.push(m));
		expect(chat.snapshot()).toEqual({
			state: {
				leafId: null,
				model: null,
				effort: null,
				efforts: [],
				working: false,
				pending: [],
				usage: null,
				name: null,
				waitingForUser: null,
			},
			models: [],
			commands: [],
			reply: { blocks: [] },
			tools: [],
		});
		chat.handle("agent_settled", undefined, ctx as never);
	});
});

// Recorded pi 1.5.2 hook events (test/fixtures/pi/README.md).
describe("replaying what a live pi did", () => {
	const FIXTURES = join(import.meta.dir, "fixtures", "pi");
	const cases = ["00-startup", "b-tools", "c-escape", "d-steer", "e-compact", "e0-compact-too-small", "f-tree", "g-new", "h-model-thinking", "i-reload"];

	function replay(name: string) {
		const t = setup();
		const lines = readFileSync(join(FIXTURES, `events-${name}.jsonl`), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { name: string; payload: Record<string, unknown> });
		return { ...t, lines };
	}

	/** Every message has the shape the protocol says. */
	function checkShape(m: ChatMessage) {
		switch (m.type) {
			case "state":
				expect(Object.keys(m).sort()).toEqual(
					["type", "leafId", "model", "effort", "efforts", "working", "pending", "usage", "name", "waitingForUser"].sort(),
				);
				expect(typeof m.working).toBe("boolean");
				expect(Array.isArray(m.pending) && Array.isArray(m.efforts)).toBe(true);
				break;
			case "tool":
				expect(["start", "end"]).toContain(m.phase);
				expect(typeof m.callId).toBe("string");
				expect(typeof m.name).toBe("string");
				break;
			case "entries":
				expect(typeof m.replyDone).toBe("boolean");
				break;
			case "reply":
				expect(m.blocks.length).toBeGreaterThan(0);
				break;
			case "notice":
				expect(typeof m.text).toBe("string");
				break;
			case "models":
			case "commands":
				expect(Array.isArray(m.list)).toBe(true);
				break;
			default:
				throw new Error(`unexpected message ${JSON.stringify(m)}`);
		}
	}

	test.each(cases)("%s: every message is valid, and it ends settled", async (name) => {
		const { s, chat, fire, sent, of, lines } = replay(name);
		let n = 0;
		for (const { name: ev, payload } of lines) {
			if (ev === "agent_start") s.idle = false;
			if (ev === "agent_settled") s.idle = true;
			s.leaf = `leaf-${++n}`;
			fire(ev, payload); // events chat doesn't know are ignored
			if (n % 10 === 0) await tickOnce();
		}
		await sleep(REPLY_EVERY_MS + 10);
		for (const m of sent) checkShape(m);
		if (lines.some((l) => l.name === "agent_settled")) {
			expect(of("state").at(-1)?.working).toBe(false);
			expect(chat.snapshot().tools).toEqual([]);
			expect(chat.snapshot().state.pending).toEqual([]);
		}
		const ended = lines.some((l) => l.name === "message_end" && (l.payload.message as { role?: string })?.role === "assistant");
		if (ended) expect(of("entries").some((e) => e.replyDone)).toBe(true);
		const tools = lines.filter((l) => l.name === "tool_execution_start").length;
		expect(of("tool").filter((t) => t.phase === "start")).toHaveLength(tools);
		expect(of("tool").filter((t) => t.phase === "end")).toHaveLength(tools);
	});

	test("d-steer: the steer is pending until pi sends it", async () => {
		const { chat, fire, lines } = replay("d-steer");
		const seen: number[] = [];
		for (const { name: ev, payload } of lines) {
			fire(ev, payload);
			seen.push(chat.state().pending.length);
		}
		expect(seen).toContain(1);
		const steerAt = lines.findIndex((l) => l.name === "input" && l.payload.streamingBehavior === "steer");
		const sentAt = lines.findIndex((l, i) => i > steerAt && l.name === "message_start" && (l.payload.message as { role?: string }).role === "user");
		expect(seen.slice(steerAt, sentAt)).toEqual(Array(sentAt - steerAt).fill(1));
		expect(seen[sentAt]).toBe(0);
	});

	test("e0-compact-too-small: pi's error text is the notice", () => {
		const { fire, of, lines } = replay("e0-compact-too-small");
		for (const { name: ev, payload } of lines) fire(ev, payload);
		expect(of("notice")).toEqual([{ type: "notice", level: "error", text: "Compaction failed: Nothing to compact (session too small)" }]);
	});
});
