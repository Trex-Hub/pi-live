import { describe, expect, test } from "bun:test";
import { BUILTIN_COMMANDS, runAction } from "../src/actions";

type FakeModel = { provider: string; id: string; reasoning?: boolean };

/** A fake pi + ctx that records what the action did. */
function setup(init: { idle?: boolean; hasUI?: boolean; model?: FakeModel; apiKey?: boolean; noCtx?: boolean } = {}) {
	const calls: unknown[][] = [];
	const known: FakeModel[] = [{ provider: "anthropic", id: "claude", reasoning: true }];
	const ctx = {
		hasUI: init.hasUI ?? true,
		isIdle: () => init.idle ?? true,
		abort: () => calls.push(["abort"]),
		compact: (options: unknown) => calls.push(["compact", options]),
		ui: { setEditorText: (text: string) => calls.push(["setEditorText", text]) },
		model: init.model,
		modelRegistry: { find: (provider: string, id: string) => known.find((m) => m.provider === provider && m.id === id) },
	};
	const pi = {
		sendUserMessage: (...args: unknown[]) => calls.push(["sendUserMessage", ...args]),
		setModel: async (model: FakeModel) => {
			calls.push(["setModel", model.id]);
			return init.apiKey ?? true;
		},
		setThinkingLevel: (level: string) => calls.push(["setThinkingLevel", level]),
		setSessionName: (name: string) => calls.push(["setSessionName", name]),
	};
	let changed = 0;
	const run = (action: Record<string, unknown>) =>
		runAction(action, { pi: pi as never, ctx: () => (init.noCtx ? undefined : (ctx as never)), changed: () => changed++ });
	return { run, calls, changed: () => changed };
}

const refused = (error: string) => ({ ok: false, error });

describe("send", () => {
	test("idle: sent as a new prompt with templates expanded", async () => {
		const { run, calls } = setup({ idle: true });
		expect(await run({ op: "send", text: "hello", deliverAs: "followUp" })).toEqual({ ok: true });
		expect(calls).toEqual([["sendUserMessage", "hello", { expandPromptTemplates: true }]]);
	});

	test("working: steer by default, followUp if asked", async () => {
		const { run, calls } = setup({ idle: false });
		await run({ op: "send", text: "a" });
		await run({ op: "send", text: "/review the diff", deliverAs: "followUp" });
		expect(calls).toEqual([
			["sendUserMessage", "a", { expandPromptTemplates: true, deliverAs: "steer" }],
			["sendUserMessage", "/review the diff", { expandPromptTemplates: true, deliverAs: "followUp" }],
		]);
	});

	test("empty, non-text and bad deliverAs are refused", async () => {
		const { run, calls } = setup();
		for (const text of ["", "  \n", undefined, 5]) expect(await run({ op: "send", text })).toEqual(refused("There is nothing to send."));
		expect(await run({ op: "send", text: "x", deliverAs: "now" })).toEqual(refused("pi can't deliver a message as “now”. Use steer or followUp."));
		expect(calls).toEqual([]);
	});

	test("every pi built-in is refused, with or without arguments", async () => {
		const { run, calls } = setup();
		expect(BUILTIN_COMMANDS).toHaveLength(26);
		for (const command of BUILTIN_COMMANDS) {
			expect(await run({ op: "send", text: command })).toEqual(
				refused(`pi-live can't run ${command}. Use the matching action, or type it in pi's terminal.`),
			);
		}
		expect(await run({ op: "send", text: "  /new please" })).toEqual(
			refused("pi-live can't run /new. Use the matching action, or type it in pi's terminal."),
		);
		expect(calls).toEqual([]);
		// Not built-ins: extension commands, prompt templates, a slash later in the text.
		for (const text of ["/newsletter", "/review", "use /new later"]) expect(await run({ op: "send", text })).toEqual({ ok: true });
	});
});

test("stop aborts", async () => {
	const { run, calls } = setup({ idle: false });
	expect(await run({ op: "stop" })).toEqual({ ok: true });
	expect(calls).toEqual([["abort"]]);
});

describe("set_model", () => {
	test("switches and refreshes state", async () => {
		const { run, calls, changed } = setup();
		expect(await run({ op: "set_model", model: "anthropic/claude" })).toEqual({ ok: true });
		expect(calls).toEqual([["setModel", "claude"]]);
		expect(changed()).toBe(1);
	});

	test("unknown model and missing API key are refused", async () => {
		const { run } = setup();
		for (const model of ["nope/x", "claude", "/claude", ""]) {
			expect(await run({ op: "set_model", model })).toEqual(refused(`pi does not know the model “${model}”.`));
		}
		expect(await run({ op: "set_model" })).toEqual(refused("pi does not know the model “”."));
		const noKey = setup({ apiKey: false });
		expect(await noKey.run({ op: "set_model", model: "anthropic/claude" })).toEqual(
			refused("No API key is set up for anthropic, so pi cannot switch to that model."),
		);
		expect(noKey.changed()).toBe(0);
	});
});

describe("set_effort", () => {
	test("must be one the model takes", async () => {
		const { run, calls, changed } = setup({ model: { provider: "p", id: "m", reasoning: true } });
		expect(await run({ op: "set_effort", effort: "high" })).toEqual({ ok: true });
		expect(calls).toEqual([["setThinkingLevel", "high"]]);
		expect(changed()).toBe(1);
		expect(await run({ op: "set_effort", effort: "max" })).toEqual(
			refused("This model does not take the effort “max”. It takes: off, minimal, low, medium, high."),
		);
	});

	test("no model takes none", async () => {
		const { run } = setup();
		expect(await run({ op: "set_effort", effort: "off" })).toEqual(refused("This model does not take the effort “off”. It takes: none."));
	});
});

test("set_name", async () => {
	const { run, calls, changed } = setup();
	expect(await run({ op: "set_name", name: "bug hunt" })).toEqual({ ok: true });
	expect(calls).toEqual([["setSessionName", "bug hunt"]]);
	expect(changed()).toBe(1);
	for (const name of ["", " ", undefined]) expect(await run({ op: "set_name", name })).toEqual(refused("There is no name to set."));
});

test("compact passes instructions; a failure is left to pi's session_compact_failed", async () => {
	const { run, calls } = setup();
	expect(await run({ op: "compact", instructions: "keep the plan" })).toEqual({ ok: true });
	expect(await run({ op: "compact" })).toEqual({ ok: true });
	expect(calls).toMatchObject([
		["compact", { customInstructions: "keep the plan" }],
		["compact", { customInstructions: undefined }],
	]);
	const onError = (calls[0]?.[1] as { onError: (e: Error) => void }).onError;
	expect(() => onError(new Error("boom"))).not.toThrow();
});

test("clear_input empties pi's editor; without a UI it is a no-op", async () => {
	const ui = setup({ hasUI: true });
	expect(await ui.run({ op: "clear_input" })).toEqual({ ok: true });
	expect(ui.calls).toEqual([["setEditorText", ""]]);
	const headless = setup({ hasUI: false });
	expect(await headless.run({ op: "clear_input" })).toEqual({ ok: true });
	expect(headless.calls).toEqual([]);
});

test("unknown op, no session, and pi throwing are refusals, never rejections", async () => {
	const { run } = setup();
	expect(await run({ op: "dance" })).toEqual(refused("pi does not know that action."));
	expect(await run({})).toEqual(refused("pi does not know that action."));
	expect(await setup({ noCtx: true }).run({ op: "stop" })).toEqual(refused("pi has no session yet."));
	const stale = runActionThrowing(new Error("This extension ctx is stale"));
	expect(await stale).toEqual(refused("This extension ctx is stale"));
	expect(await runActionThrowing("not an error")).toEqual(refused("pi could not do that."));
});

function runActionThrowing(thrown: unknown) {
	const ctx = {
		abort: () => {
			throw thrown;
		},
	};
	return runAction({ op: "stop" }, { pi: {} as never, ctx: () => ctx as never, changed: () => {} });
}
