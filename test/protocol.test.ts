import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_CLOSED, CHANNEL_PARK, CHANNEL_READY, CHANNEL_WHO, PROTOCOL_VERSION } from "../src/protocol";

test("protocol version and channel names", () => {
	expect(PROTOCOL_VERSION).toBe(1);
	expect([CHANNEL_PARK, CHANNEL_READY, CHANNEL_CLOSED, CHANNEL_WHO]).toEqual([
		"pi-live:park",
		"pi-live:ready",
		"pi-live:closed",
		"pi-live:who",
	]);
});

test("protocol.ts has no imports, so clients can copy it", () => {
	const source = readFileSync(join(import.meta.dir, "../src/protocol.ts"), "utf8");
	expect(source).not.toMatch(/^\s*import\b/m);
	expect(source).not.toMatch(/\brequire\(/);
});
