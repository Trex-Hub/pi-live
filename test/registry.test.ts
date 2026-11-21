import { describe, expect, test } from "bun:test";
import type { AnswerOutcome, AnswerResult, ClientInfo, CloseOutcome, Item, ParkRequest, ParkTicket } from "../src/protocol";
import { RECENTLY_CLOSED_LIMIT, Registry } from "../src/registry";

type Event = { type: "opened"; item: Item } | { type: "closed"; id: string; outcome: CloseOutcome } | { type: "reply"; result: AnswerResult };

function setup() {
	const events: Event[] = [];
	const logs: string[] = [];
	const registry = new Registry(
		{
			opened: (item) => events.push({ type: "opened", item }),
			closed: (id, outcome) => events.push({ type: "closed", id, outcome }),
		},
		(message) => logs.push(message),
	);
	const reply = (result: AnswerResult) => events.push({ type: "reply", result });
	return { registry, events, logs, reply };
}

function request(overrides: Partial<ParkRequest> = {}) {
	const state: { ticket?: ParkTicket; answers: Array<{ answer: unknown; from: ClientInfo }> } = { answers: [] };
	const req: ParkRequest = {
		protocol: 1,
		id: "call_1",
		owner: "ask_user",
		kind: "ask_user.question",
		title: "Favorite color?",
		view: { options: ["Red", "Green"] },
		answer: (answer, from) => {
			state.answers.push({ answer, from });
			return { status: "delivered" };
		},
		accept: (ticket) => {
			state.ticket = ticket;
		},
		...overrides,
	};
	return { req, state };
}

const client: ClientInfo = { connId: "c1", name: "test" };

describe("park", () => {
	test("valid park is accepted synchronously and reported as opened", () => {
		const { registry, events } = setup();
		const { req, state } = request({ expiresAt: 123 });
		expect(registry.park(req)).toBe(true);
		expect(state.ticket).toBeDefined();
		expect(events).toHaveLength(1);
		const opened = events[0] as Extract<Event, { type: "opened" }>;
		expect(opened.type).toBe("opened");
		expect(opened.item).toEqual({
			id: "call_1",
			owner: "ask_user",
			kind: "ask_user.question",
			title: "Favorite color?",
			view: { options: ["Red", "Green"] },
			openedAt: expect.any(Number),
			expiresAt: 123,
		});
		expect(Object.keys(opened.item)).not.toContain("answer");
		expect(registry.items()).toEqual([opened.item]);
	});

	test("expiresAt is omitted when not given", () => {
		const { registry } = setup();
		registry.park(request().req);
		expect("expiresAt" in registry.items()[0]!).toBe(false);
	});

	test("view is snapshotted at park time", () => {
		const { registry } = setup();
		const view = { options: ["Red"] };
		registry.park(request({ view }).req);
		view.options.push("Blue");
		expect(registry.items()[0]!.view).toEqual({ options: ["Red"] });
	});

	const bad: Array<[string, unknown]> = [
		["non-object", "nope"],
		["null", null],
		["protocol 2", { protocol: 2 }],
		["missing protocol", { protocol: undefined }],
		["empty id", { id: "" }],
		["numeric id", { id: 5 }],
		["empty owner", { owner: "" }],
		["missing kind", { kind: undefined }],
		["empty title", { title: "" }],
		["view with a function", { view: () => 1 }],
		["undefined view", { view: undefined }],
		["view with a bigint", { view: { n: 1n } }],
		["circular view", { view: (() => { const v: Record<string, unknown> = {}; v.self = v; return v; })() }],
		["non-number expiresAt", { expiresAt: "soon" }],
		["missing answer", { answer: undefined }],
		["missing accept", { accept: undefined }],
	];
	for (const [name, override] of bad) {
		test(`rejects ${name} without calling accept`, () => {
			const { registry, events, logs } = setup();
			let accepted = false;
			const base = request().req;
			const data =
				typeof override === "object" && override !== null
					? { ...base, accept: () => { accepted = true; }, ...override }
					: override;
			expect(registry.park(data)).toBe(false);
			expect(accepted).toBe(false);
			expect(events).toEqual([]);
			expect(registry.items()).toEqual([]);
			expect(logs).toHaveLength(1);
		});
	}

	test("duplicate open id is rejected and the live entry is kept", () => {
		const { registry, events } = setup();
		const first = request();
		registry.park(first.req);
		const second = request({ title: "other" });
		expect(registry.park(second.req)).toBe(false);
		expect(second.state.ticket).toBeUndefined();
		expect(registry.items().map((i) => i.title)).toEqual(["Favorite color?"]);
		expect(events).toHaveLength(1);
	});

	test("an id can be parked again after it closed", () => {
		const { registry, reply, events } = setup();
		const first = request();
		registry.park(first.req);
		first.state.ticket!.close({ by: "keyboard" });
		const second = request();
		expect(registry.park(second.req)).toBe(true);
		events.length = 0;
		registry.answer("call_1", "x", client, reply);
		expect(events[0]).toEqual({ type: "reply", result: { status: "delivered" } });
	});

	test("accept that throws rejects the park", () => {
		const { registry, events } = setup();
		const { req } = request({ accept: () => { throw new Error("boom"); } });
		expect(registry.park(req)).toBe(false);
		expect(registry.items()).toEqual([]);
		expect(events).toEqual([]);
	});

	test("items are listed oldest first", () => {
		const { registry } = setup();
		registry.park(request({ id: "a" }).req);
		registry.park(request({ id: "b" }).req);
		registry.park(request({ id: "c" }).req);
		expect(registry.items().map((i) => i.id)).toEqual(["a", "b", "c"]);
	});
});

describe("answer", () => {
	test("delivered: parker gets the answer, reply comes before closed", () => {
		const { registry, events, reply } = setup();
		const { req, state } = request();
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", { kind: "freeform", text: "hi" }, client, reply);
		expect(state.answers).toEqual([{ answer: { kind: "freeform", text: "hi" }, from: client }]);
		expect(events).toEqual([
			{ type: "reply", result: { status: "delivered" } },
			{ type: "closed", id: "call_1", outcome: { by: "client", client } },
		]);
		expect(registry.items()).toEqual([]);
	});

	test("delivered with a synchronous close inside answer(): one closed, after the reply", () => {
		const { registry, events, reply } = setup();
		const holder: { ticket?: ParkTicket } = {};
		const { req } = request({
			accept: (t) => { holder.ticket = t; },
			answer: (_a, from) => {
				holder.ticket!.close({ by: "client", client: from });
				holder.ticket!.close({ by: "client", client: from });
				return { status: "delivered" };
			},
		});
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		expect(events).toEqual([
			{ type: "reply", result: { status: "delivered" } },
			{ type: "closed", id: "call_1", outcome: { by: "client", client } },
		]);
	});

	test("delivered with an async close: later close is a no-op", async () => {
		const { registry, events, reply } = setup();
		const { req, state } = request({
			answer: () => {
				queueMicrotask(() => state.ticket!.close({ by: "client", client }));
				return { status: "delivered" };
			},
		});
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual([
			{ type: "reply", result: { status: "delivered" } },
			{ type: "closed", id: "call_1", outcome: { by: "client", client } },
		]);
	});

	test("delivered and the parker never closes: pi-live closes it", () => {
		const { registry, events, reply } = setup();
		const { req } = request({ answer: () => ({ status: "delivered" }) });
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		expect(events.map((e) => e.type)).toEqual(["reply", "closed"]);
		expect(registry.items()).toEqual([]);
	});

	test("invalid: reason passed through, item stays open", () => {
		const { registry, events, reply } = setup();
		const { req } = request({ answer: () => ({ status: "invalid", reason: 'option "Purple" not offered' }) });
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		expect(events).toEqual([{ type: "reply", result: { status: "invalid", reason: 'option "Purple" not offered' } }]);
		expect(registry.items()).toHaveLength(1);
	});

	test("throwing answer() counts as invalid 'parker error'", () => {
		const { registry, events, reply, logs } = setup();
		const { req } = request({ answer: () => { throw new Error("bug"); } });
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		expect(events).toEqual([{ type: "reply", result: { status: "invalid", reason: "parker error" } }]);
		expect(registry.items()).toHaveLength(1);
		expect(logs.some((l) => l.includes("bug"))).toBe(true);
	});

	test("malformed answer() return value counts as invalid 'parker error'", () => {
		const { registry, events, reply } = setup();
		const { req } = request({ answer: (() => undefined) as unknown as ParkRequest["answer"] });
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		expect(events).toEqual([{ type: "reply", result: { status: "invalid", reason: "parker error" } }]);
	});

	test("invalid with a close inside answer(): reply first, then closed with the parker's outcome", () => {
		const { registry, events, reply } = setup();
		const holder: { ticket?: ParkTicket } = {};
		const { req } = request({
			accept: (t) => { holder.ticket = t; },
			answer: (): AnswerOutcome => {
				holder.ticket!.close({ by: "error" });
				return { status: "invalid", reason: "not open" };
			},
		});
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		expect(events).toEqual([
			{ type: "reply", result: { status: "invalid", reason: "not open" } },
			{ type: "closed", id: "call_1", outcome: { by: "error" } },
		]);
	});

	test("unknown id gets not_found", () => {
		const { registry, events, reply } = setup();
		registry.answer("nope", 1, client, reply);
		expect(events).toEqual([{ type: "reply", result: { status: "not_found" } }]);
	});

	test("closed id gets closed and the parker is not called", () => {
		const { registry, events, reply } = setup();
		const { req, state } = request();
		registry.park(req);
		state.ticket!.close({ by: "keyboard" });
		events.length = 0;
		registry.answer("call_1", 1, client, reply);
		expect(events).toEqual([{ type: "reply", result: { status: "closed" } }]);
		expect(state.answers).toEqual([]);
	});

	test("race: two answers back to back → one delivered, one closed, answer() called once", () => {
		const { registry, events, reply } = setup();
		const { req, state } = request();
		registry.park(req);
		events.length = 0;
		registry.answer("call_1", "a", { connId: "c1", name: "one" }, reply);
		registry.answer("call_1", "b", { connId: "c2", name: "two" }, reply);
		expect(state.answers).toHaveLength(1);
		expect(events).toEqual([
			{ type: "reply", result: { status: "delivered" } },
			{ type: "closed", id: "call_1", outcome: { by: "client", client: { connId: "c1", name: "one" } } },
			{ type: "reply", result: { status: "closed" } },
		]);
	});

	test("recently closed keeps the last 256 ids", () => {
		const { registry, events, reply } = setup();
		for (let i = 0; i <= RECENTLY_CLOSED_LIMIT; i++) {
			const { req, state } = request({ id: `id${i}` });
			registry.park(req);
			state.ticket!.close({ by: "timeout" });
		}
		events.length = 0;
		registry.answer("id0", 1, client, reply);
		registry.answer("id1", 1, client, reply);
		registry.answer(`id${RECENTLY_CLOSED_LIMIT}`, 1, client, reply);
		expect(events.map((e) => (e as Extract<Event, { type: "reply" }>).result.status)).toEqual([
			"not_found",
			"closed",
			"closed",
		]);
	});
});

describe("close", () => {
	for (const by of ["keyboard", "timeout", "abort", "error"] as const) {
		test(`parker close by ${by} reports closed and is idempotent`, () => {
			const { registry, events } = setup();
			const { req, state } = request();
			registry.park(req);
			events.length = 0;
			state.ticket!.close({ by });
			state.ticket!.close({ by: "keyboard" });
			expect(events).toEqual([{ type: "closed", id: "call_1", outcome: { by } }]);
			expect(registry.items()).toEqual([]);
		});
	}

	test("a stale ticket does not close a re-parked item with the same id", () => {
		const { registry } = setup();
		const first = request();
		registry.park(first.req);
		first.state.ticket!.close({ by: "keyboard" });
		registry.park(request().req);
		first.state.ticket!.close({ by: "keyboard" });
		expect(registry.items()).toHaveLength(1);
	});

	test("unknown close reasons are reported as error", () => {
		const { registry, events } = setup();
		const { req, state } = request();
		registry.park(req);
		events.length = 0;
		state.ticket!.close({ by: "weird" } as unknown as CloseOutcome);
		expect(events).toEqual([{ type: "closed", id: "call_1", outcome: { by: "error" } }]);
	});

	test("closeAll closes every item in order with the given outcome", () => {
		const { registry, events } = setup();
		const a = request({ id: "a" });
		const b = request({ id: "b" });
		registry.park(a.req);
		registry.park(b.req);
		events.length = 0;
		registry.closeAll({ by: "shutdown" });
		expect(events).toEqual([
			{ type: "closed", id: "a", outcome: { by: "shutdown" } },
			{ type: "closed", id: "b", outcome: { by: "shutdown" } },
		]);
		a.state.ticket!.close({ by: "keyboard" });
		expect(events).toHaveLength(2);
	});
});
