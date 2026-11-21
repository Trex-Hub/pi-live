import {
	PROTOCOL_VERSION,
	type AnswerOutcome,
	type AnswerResult,
	type ClientInfo,
	type CloseOutcome,
	type Item,
	type ParkRequest,
	type ParkTicket,
} from "./protocol";

/** How many closed ids to remember, so late answers get `closed` instead of `not_found`. */
export const RECENTLY_CLOSED_LIMIT = 256;

const CLOSE_BY = new Set<CloseOutcome["by"]>(["keyboard", "client", "timeout", "abort", "error", "shutdown"]);

export interface RegistryListener {
	opened(item: Item): void;
	closed(id: string, outcome: CloseOutcome): void;
}

interface Entry {
	item: Item;
	answer: ParkRequest["answer"];
}

/**
 * Open items for one session, plus recently closed ids.
 *
 * Every change is reported synchronously to the listener. First valid answer
 * wins: a `delivered` answer closes the item before `answer()` returns, so any
 * later answer for the same id gets `closed`.
 */
export class Registry {
	private readonly open = new Map<string, Entry>();
	private readonly recentlyClosed = new Set<string>();
	/** Entry whose parker `answer()` is currently running, and a close it asked for meanwhile. */
	private answering: { entry: Entry; deferred?: CloseOutcome } | undefined;

	constructor(
		private readonly listener: RegistryListener,
		private readonly log: (message: string) => void = () => {},
	) {}

	/** Open items, oldest first. */
	items(): Item[] {
		return [...this.open.values()].map((entry) => entry.item);
	}

	/** Handle a `pi-live:park` payload. Returns true if it was accepted. */
	park(data: unknown): boolean {
		const problem = checkPark(data);
		if (problem) {
			this.log(`rejected park: ${problem}`);
			return false;
		}
		const request = data as ParkRequest;
		if (this.open.has(request.id)) {
			this.log(`rejected park: id ${JSON.stringify(request.id)} is already open`);
			return false;
		}

		const item: Item = {
			id: request.id,
			owner: request.owner,
			kind: request.kind,
			title: request.title,
			// Snapshot, so every client sees what was parked even if the parker mutates its object.
			view: JSON.parse(JSON.stringify(request.view)),
			openedAt: Date.now(),
			...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
		};
		const entry: Entry = { item, answer: request.answer };
		const ticket: ParkTicket = { close: (outcome) => this.closeFromParker(entry, outcome) };

		this.open.set(item.id, entry);
		this.recentlyClosed.delete(item.id);
		try {
			request.accept(ticket);
		} catch (error) {
			this.open.delete(item.id);
			this.log(`rejected park: accept() threw: ${errorMessage(error)}`);
			return false;
		}
		// accept() may already have closed it.
		if (this.open.get(item.id) === entry) this.listener.opened(item);
		return true;
	}

	/**
	 * Route a client answer to the parker. `reply` is called exactly once, and
	 * always before the resulting `closed` notification, if any.
	 */
	answer(id: string, answer: unknown, from: ClientInfo, reply: (result: AnswerResult) => void): void {
		const entry = this.open.get(id);
		if (!entry) {
			reply({ status: this.recentlyClosed.has(id) ? "closed" : "not_found" });
			return;
		}

		let outcome: AnswerOutcome;
		const answering: { entry: Entry; deferred?: CloseOutcome } = { entry };
		this.answering = answering;
		try {
			outcome = normalizeOutcome(entry.answer(answer, { connId: from.connId, name: from.name }));
		} catch (error) {
			this.log(`answer() for ${JSON.stringify(id)} threw: ${errorMessage(error)}`);
			outcome = { status: "invalid", reason: "parker error" };
		} finally {
			this.answering = undefined;
		}

		reply(outcome);
		if (this.open.get(id) !== entry) return;
		if (outcome.status === "delivered") {
			this.finish(entry, { by: "client", client: { connId: from.connId, name: from.name } });
		} else if (answering.deferred) {
			this.finish(entry, answering.deferred);
		}
	}

	/** Close every open item (session shutdown). */
	closeAll(outcome: CloseOutcome): void {
		for (const entry of [...this.open.values()]) this.finish(entry, outcome);
	}

	private closeFromParker(entry: Entry, outcome: CloseOutcome): void {
		if (this.open.get(entry.item.id) !== entry) return; // already closed: idempotent
		const normalized = normalizeClose(outcome);
		if (this.answering?.entry === entry) {
			// Inside the parker's answer(): hold it so answer_result goes out first.
			this.answering.deferred ??= normalized;
			return;
		}
		this.finish(entry, normalized);
	}

	private finish(entry: Entry, outcome: CloseOutcome): void {
		const id = entry.item.id;
		this.open.delete(id);
		this.recentlyClosed.delete(id);
		this.recentlyClosed.add(id);
		if (this.recentlyClosed.size > RECENTLY_CLOSED_LIMIT) {
			const oldest = this.recentlyClosed.values().next().value as string;
			this.recentlyClosed.delete(oldest);
		}
		this.listener.closed(id, outcome);
	}
}

/** Returns why a park payload is unacceptable, or undefined if it's fine. */
function checkPark(data: unknown): string | undefined {
	if (typeof data !== "object" || data === null) return "payload is not an object";
	const request = data as Record<string, unknown>;
	if (request.protocol !== PROTOCOL_VERSION) return `unsupported protocol ${JSON.stringify(request.protocol)}`;
	for (const field of ["id", "owner", "kind", "title"]) {
		const value = request[field];
		if (typeof value !== "string" || value.length === 0) return `${field} must be a non-empty string`;
	}
	if (typeof request.answer !== "function") return "answer must be a function";
	if (typeof request.accept !== "function") return "accept must be a function";
	if (request.expiresAt !== undefined && !(typeof request.expiresAt === "number" && Number.isFinite(request.expiresAt))) {
		return "expiresAt must be a finite number";
	}
	try {
		if (typeof JSON.stringify(request.view) !== "string") return "view is not JSON-serializable";
	} catch {
		return "view is not JSON-serializable";
	}
	return undefined;
}

function normalizeOutcome(value: unknown): AnswerOutcome {
	const outcome = value as Partial<{ status: unknown; reason: unknown }> | undefined;
	if (outcome?.status === "delivered") return { status: "delivered" };
	if (outcome?.status === "invalid" && typeof outcome.reason === "string") {
		return { status: "invalid", reason: outcome.reason };
	}
	return { status: "invalid", reason: "parker error" };
}

function normalizeClose(outcome: CloseOutcome | undefined): CloseOutcome {
	const by = CLOSE_BY.has(outcome?.by as CloseOutcome["by"]) ? outcome!.by : "error";
	const client = outcome?.client;
	if (by === "client" && client && typeof client.connId === "string" && typeof client.name === "string") {
		return { by, client: { connId: client.connId, name: client.name } };
	}
	return { by };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
