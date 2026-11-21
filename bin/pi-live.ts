#!/usr/bin/env bun
// Dev CLI for manual testing: bun bin/pi-live.ts ls | watch [sessionId|path] | answer <sessionId|path> <id> '<json>'

import { readdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { pidAlive, probeSocket, readSidecar, sidecarPathFor, socketPathFor } from "../src/paths";
import type { ServerMessage, Sidecar } from "../src/protocol";
import { loadSettings } from "../src/settings";

const USAGE = `usage:
  bun bin/pi-live.ts ls
  bun bin/pi-live.ts watch [sessionId|path]
  bun bin/pi-live.ts answer <sessionId|path> <id> '<json>'`;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function sidecars(dir: string): Sidecar[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((n) => n.endsWith(".json"))
		.map((n) => readSidecar(join(dir, n)))
		.filter((s): s is Sidecar => typeof s?.sessionId === "string");
}

async function isLive(s: Sidecar): Promise<boolean> {
	return pidAlive(s.pid) && (await probeSocket(s.socketPath)) === "live";
}

async function ls(dir: string): Promise<void> {
	const all = sidecars(dir);
	if (all.length === 0) {
		console.log(`no sessions in ${dir}`);
		return;
	}
	for (const s of all) {
		console.log([s.sessionId, (await isLive(s)) ? "alive" : "dead", `pid ${s.pid}`, s.cwd].join("\t"));
	}
}

/** A path (contains a separator or ends in .sock) or a session id. With no target, the only live session. */
async function resolveTarget(dir: string, target: string | undefined): Promise<string> {
	if (target === undefined) {
		const live: Sidecar[] = [];
		for (const s of sidecars(dir)) if (await isLive(s)) live.push(s);
		if (live.length === 1) return live[0]!.socketPath;
		fail(live.length === 0 ? `no live sessions in ${dir}` : `several live sessions in ${dir}; pass a session id`);
	}
	if (target.includes("/") || target.includes("\\") || target.endsWith(".sock")) return target;
	return readSidecar(sidecarPathFor(dir, target))?.socketPath ?? socketPathFor(dir, target);
}

/** Connect, say hello and call `onMessage` for each line; resolves when the connection closes. */
function session(path: string, onMessage: (line: string, message: ServerMessage, socket: Socket) => void): Promise<void> {
	return new Promise((resolve) => {
		const socket = connect(path);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", protocol: 1, client: { name: "pi-live-cli" } })}\n`));
		socket.on("error", (error) => fail(`${path}: ${error.message}`));
		socket.on("close", () => resolve());
		socket.on("data", (data: string) => {
			buffer += data;
			let i = buffer.indexOf("\n");
			while (i !== -1) {
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				onMessage(line, JSON.parse(line) as ServerMessage, socket);
				i = buffer.indexOf("\n");
			}
		});
	});
}

async function watch(path: string): Promise<void> {
	await session(path, (line) => console.log(line));
}

async function answer(path: string, id: string, json: string): Promise<void> {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		fail(`answer is not valid JSON: ${(error as Error).message}`);
	}
	let result: ServerMessage | undefined;
	await session(path, (line, message, socket) => {
		if (message.type === "welcome") {
			socket.write(`${JSON.stringify({ type: "answer", reqId: "cli", id, answer: value })}\n`);
		} else if (message.type === "answer_result" && message.reqId === "cli") {
			console.log(line);
			result = message;
			socket.end();
		} else if (message.type === "error" || message.type === "goodbye") {
			console.error(line);
		}
	});
	if (!result) fail("connection closed before answer_result");
	process.exit(result.type === "answer_result" && result.status === "delivered" ? 0 : 1);
}

async function main(argv: string[]): Promise<void> {
	let dir: string;
	try {
		dir = loadSettings().dir;
	} catch (error) {
		fail((error as Error).message);
	}
	const [cmd, ...args] = argv;
	if (cmd === "ls" && args.length === 0) return ls(dir);
	if (cmd === "watch" && args.length <= 1) return watch(await resolveTarget(dir, args[0]));
	if (cmd === "answer" && args.length === 3) return answer(await resolveTarget(dir, args[0]), args[1]!, args[2]!);
	fail(USAGE);
}

await main(process.argv.slice(2));
