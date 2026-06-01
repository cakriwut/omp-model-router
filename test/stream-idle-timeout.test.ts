/**
 * Tests for stream idle timeout in the router's fallback chain.
 * Verifies that a stalled stream triggers fallback to the next model.
 */
import { describe, test, expect } from "bun:test";
import { withIdleTimeout, StreamIdleTimeoutError } from "../src/provider";
import { isRetryableStatus } from "../src/embargo";

describe("stream idle timeout", () => {
	test("withIdleTimeout yields events that arrive before deadline", async () => {
		async function* fastStream() {
			yield "a";
			await new Promise((r) => setTimeout(r, 10));
			yield "b";
			await new Promise((r) => setTimeout(r, 10));
			yield "c";
		}

		const results: string[] = [];
		for await (const item of withIdleTimeout(fastStream(), 500)) {
			results.push(item);
		}
		expect(results).toEqual(["a", "b", "c"]);
	});

	test("withIdleTimeout throws on stalled stream", async () => {
		async function* stalledStream() {
			yield "first";
			// Never yields again — simulates a hung provider
			await new Promise(() => {}); // infinite hang
		}

		const results: string[] = [];
		let caughtError: Error | undefined;

		try {
			for await (const item of withIdleTimeout(stalledStream(), 50)) {
				results.push(item);
			}
		} catch (err) {
			caughtError = err as Error;
		}

		expect(results).toEqual(["first"]);
		expect(caughtError).toBeInstanceOf(StreamIdleTimeoutError);
		expect(caughtError!.message).toContain("no event received");
	});

	test("withIdleTimeout throws on stream that never starts", async () => {
		async function* neverStartsStream() {
			await new Promise(() => {}); // hangs before first event
		}

		let caughtError: Error | undefined;
		try {
			for await (const _item of withIdleTimeout(neverStartsStream(), 50)) {
				// Should never reach here
			}
		} catch (err) {
			caughtError = err as Error;
		}

		expect(caughtError).toBeInstanceOf(StreamIdleTimeoutError);
	});

	test("withIdleTimeout completes normally on empty stream", async () => {
		async function* emptyStream() {
			// yields nothing, ends immediately
		}

		const results: string[] = [];
		for await (const item of withIdleTimeout(emptyStream(), 50)) {
			results.push(item);
		}
		expect(results).toEqual([]);
	});

	test("StreamIdleTimeoutError is treated as retryable by embargo", () => {
		expect(
			isRetryableStatus(undefined, "Stream idle timeout: no event received for 120s"),
		).toBe(true);
	});
});
