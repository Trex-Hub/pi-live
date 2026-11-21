# Examples

pi-live isn't tied to one extension. Any extension or tool that pauses for a human can park that wait with pi-live, and any connected client can answer it. This page walks through one hypothetical parker in full, then lists other ideas.

## Approving dangerous commands from your phone

A hypothetical `pi-guard` extension stops the agent before `rm -rf`, `git push --force` and similar commands. Without pi-live, you have to be at the terminal to press **y**. With pi-live, your phone buzzes while you're away and you tap Allow.

### The extension

`pi-guard` shows a confirm dialog in the terminal as usual, and also parks it with pi-live. Whichever answer comes first wins, and the other side is dismissed.

```typescript
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

const DANGEROUS = /rm -rf|push --force/;
type Ticket = { close(outcome: { by: string }): void };

export default function piGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event) || !DANGEROUS.test(event.input.command)) return;

		const dialog = new AbortController();
		let ended = false;
		let ticket: Ticket | undefined;
		let fromClient!: (allow: boolean) => void;
		const clientAnswer = new Promise<boolean>((resolve) => (fromClient = resolve));

		pi.events.emit("pi-live:park", {
			protocol: 1,
			id: event.toolCallId,
			owner: "pi-guard",
			kind: "pi-guard.approve",
			title: "Allow dangerous command?",
			view: { command: event.input.command, cwd: ctx.cwd },
			accept(t: Ticket) {
				ticket = t; // not called: pi-live isn't running, so this stays keyboard-only
			},
			answer(raw: unknown) {
				if (ended) return { status: "invalid", reason: "already decided" };
				const allow = (raw as { allow?: unknown } | null)?.allow;
				if (typeof allow !== "boolean") return { status: "invalid", reason: "expected {\"allow\": boolean}" };
				ended = true;
				fromClient(allow);
				dialog.abort(); // dismiss the terminal dialog
				return { status: "delivered" }; // pi-live closes the item itself
			},
		});

		const fromKeyboard = ctx.ui.confirm("Allow dangerous command?", event.input.command, { signal: dialog.signal });
		const allow = await Promise.race([fromKeyboard, clientAnswer]);
		if (!ended) {
			ended = true;
			ticket?.close({ by: "keyboard" });
		}
		if (!allow) return { block: true, reason: "Denied by user" };
	});
}
```

What to notice:

- `pi-guard` doesn't import pi-live. It only emits on `pi.events`, so it works the same with or without pi-live installed.
- `answer` is synchronous and validates the answer exactly as strictly as the keyboard path would.
- The `ended` flag makes a late answer, from either side, a no-op. A client that answers after the keyboard gets `invalid` back.

### What a client sees

Watching the session with `bun bin/pi-live.ts watch`:

```json
{"type":"item_opened","item":{"id":"call_42","owner":"pi-guard","kind":"pi-guard.approve","title":"Allow dangerous command?","view":{"command":"rm -rf build/","cwd":"/work"},"openedAt":1795278085572}}
```

A client that knows the `pi-guard.approve` kind shows the command with Allow and Deny buttons. Tapping Allow sends:

```json
{"type":"answer","reqId":"r1","id":"call_42","answer":{"allow":true}}
```

and the client gets back:

```json
{"type":"answer_result","reqId":"r1","id":"call_42","status":"delivered"}
{"type":"item_closed","id":"call_42","outcome":{"by":"client","client":{"connId":"c1","name":"my-phone-bridge"}}}
```

The terminal dialog disappears and the command runs. If you pressed **n** at the keyboard first, every client gets `item_closed` with `{"by":"keyboard"}` instead, and the command is blocked.

From the command line, the same answer is:

```bash
bun bin/pi-live.ts answer <sessionId> call_42 '{"allow":true}'
```

## Other ideas

Anything where the session is blocked on a human decision can be parked the same way:

| Extension | What it parks | A client's answer |
|---|---|---|
| Plan review | The plan as markdown, to approve or comment on | `{"approved": false, "comments": "…"}` |
| Budget guard | "This run has spent $4. Continue?" | `{"continue": true}` |
| Merge conflict helper | Both sides of a conflicting hunk | `{"pick": "ours"}` |
| Deploy gate | "Deploy to prod?" with a diff summary | `{"allow": false}` |
| Model fallback | "Opus is rate-limited. Switch to Sonnet?" | `{"model": "…"}` |
| Long-task check-in | "Tests still fail after 3 tries. How should I proceed?" | free text |

## What pi-live doesn't do

A client can only answer something the session is already waiting on. It can't send new prompts, steer the agent or abort a run.
