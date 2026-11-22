// Client actions on pi (control). Only reached when control is on.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { efforts } from "./chat";
import type { ActionOutcome } from "./protocol";

/** pi's own slash commands. `send` refuses them: they act on pi's terminal, not on the agent. */
export const BUILTIN_COMMANDS = [
	"/settings",
	"/model",
	"/thinking",
	"/scoped-models",
	"/login",
	"/logout",
	"/llama",
	"/new",
	"/resume",
	"/name",
	"/session",
	"/tree",
	"/fork",
	"/clone",
	"/compact",
	"/import",
	"/copy",
	"/export",
	"/share",
	"/bug",
	"/trust",
	"/mcp",
	"/reload",
	"/hotkeys",
	"/changelog",
	"/quit",
];

export type ActionPi = Pick<ExtensionAPI, "sendUserMessage" | "setModel" | "setThinkingLevel" | "setSessionName">;

export interface ActionContext {
	pi: ActionPi;
	/** The current session's ctx, if any. */
	ctx(): ExtensionContext | undefined;
	/** Called after a change that clients see in `state`. */
	changed(): void;
}

/** Run one action. Never rejects: a refusal or failure is `{ ok: false, error }` with a sentence an app can show. */
export async function runAction(action: Record<string, unknown>, a: ActionContext): Promise<ActionOutcome> {
	try {
		await perform(action, a);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : "pi could not do that." };
	}
}

async function perform(action: Record<string, unknown>, { pi, ctx, changed }: ActionContext): Promise<void> {
	const c = ctx();
	if (!c) throw new Error("pi has no session yet.");
	switch (action.op) {
		case "send": {
			const { text, deliverAs } = action;
			if (typeof text !== "string" || text.trim() === "") throw new Error("There is nothing to send.");
			const first = text.trim().split(/\s+/)[0] ?? "";
			if (BUILTIN_COMMANDS.includes(first)) {
				throw new Error(`pi-live can't run ${first}. Use the matching action, or type it in pi's terminal.`);
			}
			if (deliverAs !== undefined && deliverAs !== "steer" && deliverAs !== "followUp") {
				throw new Error(`pi can't deliver a message as “${String(deliverAs)}”. Use steer or followUp.`);
			}
			// While the agent works a message must say how it is delivered; Enter in pi's own box means steer.
			const as: "steer" | "followUp" = deliverAs ?? "steer";
			const options = c.isIdle() ? {} : { deliverAs: as };
			pi.sendUserMessage(text, { expandPromptTemplates: true, ...options });
			return;
		}
		case "stop":
			c.abort();
			return;
		case "set_model": {
			const text = typeof action.model === "string" ? action.model : "";
			const slash = text.indexOf("/");
			const model = slash > 0 ? c.modelRegistry.find(text.slice(0, slash), text.slice(slash + 1)) : undefined;
			if (!model) throw new Error(`pi does not know the model “${text}”.`);
			if (!(await pi.setModel(model))) {
				throw new Error(`No API key is set up for ${model.provider}, so pi cannot switch to that model.`);
			}
			changed();
			return;
		}
		case "set_effort": {
			const level = typeof action.effort === "string" ? action.effort : "";
			const allowed = efforts(c.model);
			if (!allowed.includes(level)) {
				throw new Error(`This model does not take the effort “${level}”. It takes: ${allowed.join(", ") || "none"}.`);
			}
			pi.setThinkingLevel(level as Parameters<ActionPi["setThinkingLevel"]>[0]);
			changed();
			return;
		}
		case "set_name": {
			const { name } = action;
			if (typeof name !== "string" || name.trim() === "") throw new Error("There is no name to set.");
			pi.setSessionName(name);
			changed();
			return;
		}
		case "compact": {
			const { instructions } = action;
			// pi reports a failure as session_compact_failed, which chat turns into a notice.
			c.compact({
				customInstructions: typeof instructions === "string" && instructions.trim() !== "" ? instructions : undefined,
				onError: () => {},
			});
			return;
		}
		case "clear_input":
			if (!c.hasUI) return;
			c.ui.setEditorText("");
			// pi 1.5.2 interactive-mode.js:2194 `setEditorText: (text) => this.editor.setText(text)` doesn't
			// repaint, so the old draft stays on screen. setStatus repaints (interactive-mode.js:1889-1891
			// `setExtensionStatus` → `this.ui.requestRender()`), and removing a status we never set changes
			// nothing visible. Only in the TUI: in RPC mode setStatus is sent to the RPC client.
			if (c.mode === "tui") c.ui.setStatus("pi-live", undefined);
			return;
		default:
			throw new Error("pi does not know that action.");
	}
}
