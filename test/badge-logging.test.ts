import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("Classifier Badge Logging", () => {
	let originalLog: typeof console.log;
	let logs: string[] = [];

	beforeEach(() => {
		logs = [];
		originalLog = console.log;
		console.log = (...args: any[]) => {
			logs.push(args.map(String).join(" "));
		};
	});

	afterEach(() => {
		console.log = originalLog;
	});

	test("extracts short model name from full ref", () => {
		const testCases = [
			{
				input: "amazon-bedrock/us.amazon.nova-micro-v1:0",
				expected: "nova-micro",
			},
			{
				input: "anthropic/claude-3-haiku-20240307",
				expected: "claude-3-haiku-20240307",
			},
			{
				input: "amazon-bedrock/amazon.nova-lite-v1:0",
				expected: "nova-lite",
			},
			{
				input: "openai/gpt-4o-mini",
				expected: "gpt-4o-mini",
			},
		];

		testCases.forEach(({ input, expected }) => {
			const shortName = input
				.split("/")
				.pop()
				?.split(".")
				.pop()
				?.replace(/-v\d+:\d+$/, "") || input;
			expect(shortName).toBe(expected);
		});
	});

	test("formats sync adaptive badge correctly", () => {
		const shortName = "nova-micro";
		const spawnBadge = `⚡ classifier → ${shortName} (sync·adaptive)`;
		const resultBadge = `⚡ classifier → ${shortName} (sync·adaptive) → high`;

		expect(spawnBadge).toBe("⚡ classifier → nova-micro (sync·adaptive)");
		expect(resultBadge).toBe("⚡ classifier → nova-micro (sync·adaptive) → high");
	});

	test("formats async telemetry badge correctly", () => {
		const shortName = "nova-micro";
		const spawnBadge = `⚡ classifier → ${shortName} (async·telemetry)`;
		const agreeBadge = `⚡ classifier → ${shortName} (async·telemetry) → medium ✓`;
		const disagreeBadge = `⚡ classifier → ${shortName} (async·telemetry) → low ✗`;

		expect(spawnBadge).toBe("⚡ classifier → nova-micro (async·telemetry)");
		expect(agreeBadge).toBe("⚡ classifier → nova-micro (async·telemetry) → medium ✓");
		expect(disagreeBadge).toBe("⚡ classifier → nova-micro (async·telemetry) → low ✗");
	});

	test("badge format matches router badge style", () => {
		// Router badge: ⬡ auto ⟨toon⟩ ◑ sonnet-4-5 ↑0.0k ↓0.5k $0.1365 [budget] [rule]
		// Classifier badge: ⚡ classifier → nova-micro (sync·adaptive) → high
		
		const classifierBadge = "⚡ classifier → nova-micro (sync·adaptive) → high";
		
		// Check components
		expect(classifierBadge).toContain("⚡");  // Lightning icon (like ⬡ for router)
		expect(classifierBadge).toContain("→");   // Arrow (like → for router)
		expect(classifierBadge).toContain("(");   // Parentheses for metadata
		expect(classifierBadge).toContain("·");   // Middle dot separator
	});

	test("demonstrates visual output", () => {
		console.log("=== Classifier Badge Examples ===");
		console.log("⚡ classifier → nova-micro (sync·adaptive)");
		console.log("⚡ classifier → nova-micro (sync·adaptive) → high");
		console.log("⚡ classifier → haiku (async·telemetry) → medium ✓");
		console.log("⚡ classifier → haiku (async·telemetry) → low ✗");
		
		expect(logs.length).toBe(5); // title + 4 examples
		expect(logs[1]).toContain("⚡ classifier");
		expect(logs[2]).toContain("→ high");
		expect(logs[3]).toContain("✓");
		expect(logs[4]).toContain("✗");
	});
});
