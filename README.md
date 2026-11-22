# pi-live

Follow, drive and answer your pi sessions from outside the terminal.

A pi session normally lives in one terminal: you watch it there, type there, and answer its prompts there. pi-live gives each pi session a local socket, so other programs on your machine (a web dashboard, a desktop notifier, a phone app through a bridge) can do the same:

- **Answer waits.** Anything the session is waiting on, such as a question, an approval or a plan review, can be answered from a client. The terminal prompt still shows, and the first valid answer wins.
- **Follow the chat.** Clients see the reply as it streams, tools as they run, the model and context use, and when to re-read the session file.
- **Control the session.** With control on, clients can send a prompt, steer or stop a run, switch the model or effort, and rename or compact the session.

Any extension or tool that pauses for a human can *park* its wait with pi-live. pi-live never needs to understand the prompt. It relays three things:

- **`kind`:** a label the parker chooses, so clients know how to render the prompt.
- **`view`:** JSON describing the prompt.
- **`answer`:** whatever the client sends back, which the parker validates.

pi-live has no UI of its own. It's a socket, a protocol and a small command-line client.

## Contents

- [Example](#example)
- [How it works](#how-it-works)
- [Security](#security)
- [Install](#install)
- [Try it](#try-it)
- [Configuration](#configuration)
- [For extension authors](#for-extension-authors)
- [For client authors](#for-client-authors)
- [Development](#development)
- [License](#license)

## Example

A hypothetical `pi-guard` extension stops the agent before `rm -rf`, `git push --force` and similar commands. Without pi-live, you have to be at the terminal to press **y**. With pi-live and a bridge that connects your phone to the socket and adds its own authentication, your phone buzzes while you're away and you tap Allow.

The full code, what a client sees and more ideas are in [docs/examples.md](docs/examples.md).

With chat and control, the same kind of client can do more than answer: a web dashboard can list every running pi, show each one's reply as it streams, and let you steer or stop a run from the browser.

## How it works

```
 pi session                                    outside pi
┌─────────────────────────────────────┐
│ extension ──park──▶ pi-live ◀───────┼──── socket ────▶ client (CLI, web app, …)
│     ▲                  │            │
│     └──── answer ──────┘            │
│ terminal prompt (still answerable)  │
└─────────────────────────────────────┘
```

1. An extension opens a prompt in the terminal and *parks* it with pi-live: an id, a title and a JSON view of the prompt.
2. pi-live tells every connected client that a new item is open.
3. A client sends an answer. pi-live passes it to the extension, which checks it as if it came from the keyboard. An invalid answer is rejected and the prompt stays open.
4. When the prompt ends, however it ends, pi-live tells every client the item is closed and why: answered by a client, answered at the keyboard, timed out, aborted or session ended.

A client that connects later gets the current list of open items first, then changes as they happen.

Chat works the same way. A client that asks for it gets a snapshot of the session (state, models, commands, the reply so far, running tools), then each change. Control actions go the other way and get a result back: done, or a sentence saying why not. Commands like `/new` or `/reload`, which only pi's terminal can run, are refused.

## Security

**With pi-live loaded, any program running as your user can see and answer what your pi sessions are waiting on, and follow their chat.**

**With control on (the default), any program running as your user can also send messages to the agent, which can run commands.** That's the same reach as typing into your terminal. To turn control off, set `PI_LIVE_CONTROL=0` or put `{ "control": false }` in `pi-live.json` (see [Configuration](#configuration)). Clients can still watch and answer waits.

- The socket is a Unix socket with mode `0600` in a directory with mode `0700`. Only your user on that machine can connect, the same boundary that protects your terminal and your pi configuration.
- pi-live never listens on a network port. To answer from another machine, use a client that provides its own authentication and transport.
- Clients see whatever an extension puts in a prompt's view, for example a question, its context and its options.
- On Windows, pi-live uses a named pipe. Windows support is untested.

## Install

pi-live requires pi 0.74 or later.

```bash
pi install git:github.com/Trex-Hub/pi-live
```

To try it for one run without installing:

```bash
pi -e git:github.com/Trex-Hub/pi-live
```

pi-live runs in pi's interactive and RPC modes. It does nothing in print and JSON modes, where no one is waiting at a prompt.

If several packages bundle pi-live, only the first copy loaded is active.

## Try it

Clone this repository to get the command-line client, then start pi with pi-live and an extension that parks prompts:

```bash
git clone https://github.com/Trex-Hub/pi-live && cd pi-live && bun install
```

List the sessions that have a socket:

```bash
$ bun bin/pi-live.ts ls
01a1feea-1468-750a-96d6-bf2777e60575	alive	pid 74194	/home/me/project
```

Watch one session. The first line lists the open items, and each later line is a change:

```bash
$ bun bin/pi-live.ts watch 01a1feea-1468-750a-96d6-bf2777e60575
{"type":"welcome","protocol":1,"version":"0.2.0","features":["chat","control"],"control":true,"session":{...},"connId":"c1","items":[]}
{"type":"item_opened","item":{"id":"call_1","owner":"ask_user","kind":"ask_user.question","title":"Which color?","view":{...},"openedAt":1795278085572}}
```

Answer an item. The command exits with status 0 only if the answer was delivered:

```bash
$ bun bin/pi-live.ts answer 01a1feea-1468-750a-96d6-bf2777e60575 call_1 '{"kind":"selection","selections":["Blue"]}'
{"type":"answer_result","reqId":"cli","id":"call_1","status":"delivered"}
```

The shape of the answer is set by the extension that parked the item.

The command-line client covers waits only. For chat and control, see [For client authors](#for-client-authors).

## Configuration

pi-live reads environment variables first, then `pi-live.json` in pi's agent directory (`$PI_CODING_AGENT_DIR`, or `~/.pi/agent`). Settings are read again at every session start.

| Setting | Environment variable | Default | Effect |
|---|---|---|---|
| `enabled` | `PI_LIVE_ENABLED` (`0` or `false` turns it off) | `true` | When off, there's no socket: no waits, chat or control from outside. |
| `dir` | `PI_LIVE_DIR` | `<agent dir>/live` | Directory for sockets and session files. |
| `control` | `PI_LIVE_CONTROL` (`0`/`false`/`off` or `1`/`true`/`on`) | `true` | When off, clients can watch and answer, but every action is refused. |

```json
{ "control": false }
```

This keeps answering and following the chat, but refuses every action. Use `{ "enabled": false }` to turn pi-live off entirely.

If `pi-live.json` isn't valid JSON, pi-live stays off for that session and shows a warning.

A project can turn control off for itself with `{ "control": false }` in `<project>/.pi/pi-live.json`. That file is read only if pi trusts the project, and it can't turn control on. `PI_LIVE_CONTROL` overrides both files.

`PI_LIVE_TERMINAL` names the terminal pi runs in. Clients see it in the session file and `welcome`, so they can match a session to a window.

## For extension authors

Park a prompt by emitting `pi-live:park` on `pi.events`. If pi-live is running, it calls `accept` synchronously, before `emit` returns. If `accept` wasn't called, there is no socket, so keep your keyboard-only path:

```typescript
let ticket: { close(outcome: { by: string }): void } | undefined;

pi.events.emit("pi-live:park", {
	protocol: 1,
	id: toolCallId,               // unique in this session
	owner: "my-extension",
	kind: "my-extension.confirm", // tells clients how to read `view`
	title: "Deploy to production?",
	view: { question: "Deploy to production?", choices: ["yes", "no"] },
	accept(t) {
		ticket = t;
	},
	answer(raw, from) {
		// Called with a client's answer. Must be synchronous.
		if (raw !== "yes" && raw !== "no") return { status: "invalid", reason: "expected yes or no" };
		resolvePrompt(raw); // finish your prompt as if the user had typed it
		return { status: "delivered" };
	},
});

// When your prompt ends for any other reason:
ticket?.close({ by: "keyboard" }); // or "timeout", "abort", "error"
```

- Call `ticket.close` once when the prompt ends. Extra calls are ignored.
- After a client's answer is delivered, pi-live closes the item itself.
- Once your prompt has ended, return `invalid` from `answer`, so a late answer can't resolve it twice.

`pi-live:ready` and `pi-live:closed` report when a session's socket opens and closes. Emit `pi-live:who` with a `reply` function to get the current socket path.

The full API is in [docs/protocol.md](docs/protocol.md), and the types are in [src/protocol.ts](src/protocol.ts).

## For client authors

The socket speaks newline-delimited JSON. Send `hello` first, then read `welcome` with the open items, followed by `item_opened` and `item_closed` as they happen:

```jsonc
→ {"type":"hello","protocol":1,"client":{"name":"my-client"}}
← {"type":"welcome","protocol":1,"version":"0.2.0","features":["chat","control"],"control":true,"session":{"id":"…","cwd":"…","pid":1234,"mode":"tui"},"connId":"c1","items":[]}
← {"type":"item_opened","item":{"id":"call_1","kind":"…","title":"…","view":{…},"openedAt":1795278085572}}
→ {"type":"answer","reqId":"r1","id":"call_1","answer":{…}}
← {"type":"answer_result","reqId":"r1","id":"call_1","status":"delivered"}
← {"type":"item_closed","id":"call_1","outcome":{"by":"client","client":{"connId":"c1","name":"my-client"}}}
```

To find sessions, read the `<session id>.json` files in the socket directory. Each one gives the socket path, process id, working directory, mode (`tui` or `rpc`) and, if set, the terminal of a session.

Add `"chat": true` to `hello` to also get the session's chat: a snapshot in `welcome.chat`, then `state`, `reply`, `tool`, `entries` and other messages as they happen. Send `action` messages to act on pi. Check `welcome.features` for `"chat"` and `"control"` first:

```jsonc
→ {"type":"hello","protocol":1,"client":{"name":"my-client"},"chat":true}
← {"type":"welcome","protocol":1,"version":"0.2.0","features":["chat","control"],"control":true,"session":{…},"connId":"c1","items":[],"chat":{"state":{…},"models":[…],"commands":[…],"reply":{"blocks":[]},"tools":[]}}
→ {"type":"action","reqId":"a1","op":"send","text":"run the tests"}
← {"type":"action_result","reqId":"a1","ok":true}
← {"type":"state","working":true,…}
← {"type":"reply","blocks":[{"kind":"text","text":"Running the tests…"}]}
```

When a session ends, `goodbye` says why. Anything but `quit` (for example `new` or `reload`) means the same pi opens a new socket next.

pi-live doesn't send chat history. Read it from the session file named in `welcome.session.file`, and re-read it when an `entries` message arrives.

The full wire protocol is in [docs/protocol.md](docs/protocol.md). [src/protocol.ts](src/protocol.ts) has no imports, so you can copy it into a client for the types.

## Development

```bash
bun install
bun test
bun run typecheck
```

To load your checkout in pi without touching your real socket directory:

```bash
PI_LIVE_DIR=/tmp/pi-live-dev pi -e .
```

## License

[MIT](LICENSE)
