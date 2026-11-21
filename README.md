# pi-live

Answer anything your pi session is waiting on from outside the terminal: a question, an approval, a plan review.

When pi stops to wait for you, you normally have to be at that terminal. pi-live gives each pi session a local socket that lists everything the session is waiting on. Any extension or tool that pauses for a human can park that wait with pi-live. The terminal prompt still shows, and any connected client (a phone, a herdr-web tab, a desktop notifier) can show the same wait and answer it. The first valid answer wins.

pi-live never needs to understand the prompt. It relays three things:

- **`kind`:** a label the parker chooses, so clients know how to render the prompt.
- **`view`:** JSON describing the prompt.
- **`answer`:** whatever the client sends back, which the parker validates.

pi-live has no UI of its own, and it does nothing until an extension parks a wait with it.

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

A hypothetical `pi-guard` extension stops the agent before `rm -rf`, `git push --force` and similar commands. Without pi-live, you have to be at the terminal to press **y**. With pi-live, your phone buzzes while you're away and you tap Allow.

The full code, what a client sees and more ideas are in [docs/examples.md](docs/examples.md).

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

## Security

**With pi-live loaded, any program running as your user can see and answer what your pi sessions are waiting on.**

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
{"type":"welcome","protocol":1,"session":{...},"connId":"c1","items":[]}
{"type":"item_opened","item":{"id":"call_1","owner":"ask_user","kind":"ask_user.question","title":"Which color?","view":{...},"openedAt":1795278085572}}
```

Answer an item. The command exits with status 0 only if the answer was delivered:

```bash
$ bun bin/pi-live.ts answer 01a1feea-1468-750a-96d6-bf2777e60575 call_1 '{"kind":"selection","selections":["Blue"]}'
{"type":"answer_result","reqId":"cli","id":"call_1","status":"delivered"}
```

The shape of the answer is set by the extension that parked the item.

## Configuration

pi-live reads environment variables first, then `pi-live.json` in pi's agent directory (`$PI_CODING_AGENT_DIR`, or `~/.pi/agent`). Settings are read again at every session start.

| Setting | Environment variable | Default | Effect |
|---|---|---|---|
| `enabled` | `PI_LIVE_ENABLED` (`0` or `false` turns it off) | `true` | When off, there's no socket and prompts are answered only at the keyboard. |
| `dir` | `PI_LIVE_DIR` | `<agent dir>/live` | Directory for sockets and session files. |

```json
{ "enabled": false }
```

If `pi-live.json` isn't valid JSON, pi-live stays off for that session and shows a warning.

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
← {"type":"welcome","protocol":1,"session":{"id":"…","cwd":"…","pid":1234},"connId":"c1","items":[]}
← {"type":"item_opened","item":{"id":"call_1","kind":"…","title":"…","view":{…},"openedAt":1795278085572}}
→ {"type":"answer","reqId":"r1","id":"call_1","answer":{…}}
← {"type":"answer_result","reqId":"r1","id":"call_1","status":"delivered"}
← {"type":"item_closed","id":"call_1","outcome":{"by":"client","client":{"connId":"c1","name":"my-client"}}}
```

To find sessions, read the `<session id>.json` files in the socket directory. Each one gives the socket path, process id and working directory of a session.

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
