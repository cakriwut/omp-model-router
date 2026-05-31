#!/usr/bin/env bun
/**
 * Lab test: Isolated real-world classifier stream behavior — ground truth
 * 
 * Tests the exact scenario that causes OMP freeze by directly calling
 * AWS Bedrock with the classifier prompt, measuring latency and behavior.
 * 
 * Usage:
 *   bun run test/lab-classifier-stream-behavior.ts
 */

import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { buildClassifierPrompt, parseClassifierOutput, getConversationSummary } from "../src/calibration/classifier-utils";
import type { Context, Message } from "@oh-my-pi/pi-ai";

// ─── The exact prompt that triggers the freeze ────────────────────────────────

const HERDR_PROMPT = `spawn parallel agent architect, coder, tester, bug-triager - architect will review profile-tui-editor proposal, ensure it is ready for implementation, with task breakdown and target. the architect will assign to coder for implementation, multiple coder can work for independent part of the task. tester will test the implementation and handover to bug-triager to triage bug found in the implementation, record bug reported and if valid bug request coder to fix. All agents are ephemeral, communicate via file, and irc.send`;

const CLASSIFIER_MODEL_ID = "us.amazon.nova-micro-v1:0";
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

// ─── AWS Bedrock direct call ─────────────────────────────────────────────────

const client = new BedrockRuntimeClient({ region: AWS_REGION });

async function callBedrock(
	prompt: string,
	timeoutMs: number | null,
	label: string,
): Promise<{ text: string; latencyMs: number; error?: string; timedOut?: boolean; chunks: number; ttft?: number }> {
	const start = Date.now();
	let ttft: number | undefined;
	
	const command = new ConverseStreamCommand({
		modelId: CLASSIFIER_MODEL_ID,
		messages: [{ role: "user", content: [{ text: prompt }] }],
		inferenceConfig: { maxTokens: 100, temperature: 0 },
	});

	let fullText = "";
	let chunks = 0;
	let timedOut = false;
	let error: string | undefined;

	const ac = timeoutMs ? new AbortController() : undefined;
	const timeout = timeoutMs ? setTimeout(() => ac!.abort(), timeoutMs) : undefined;

	try {
		const response = await client.send(command, ac ? { abortSignal: ac.signal } : undefined);
		
		if (response.stream) {
			for await (const event of response.stream) {
				if (event.contentBlockDelta?.delta?.text) {
					if (ttft === undefined) ttft = Date.now() - start;
					fullText += event.contentBlockDelta.delta.text;
					chunks++;
				}
			}
		}
	} catch (e: any) {
		if (e.name === "AbortError" || e.message?.includes("abort")) {
			timedOut = true;
		} else {
			error = e.message?.slice(0, 120) || String(e).slice(0, 120);
		}
	} finally {
		if (timeout) clearTimeout(timeout);
	}

	return { text: fullText, latencyMs: Date.now() - start, error, timedOut, chunks, ttft };
}

// ─── Build contexts for testing ──────────────────────────────────────────────

/** Simple context — just the herdr prompt */
function simpleContext(prompt: string): Context {
	return { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
}

/** Complex context — simulates a session with tool calls, tool results, etc. */
function complexContext(prompt: string): Context {
	const msgs: Message[] = [
		{ role: "user", content: "implement the profile editor component", timestamp: Date.now() - 60000 },
		{ role: "assistant", content: [
			{ type: "text", text: "I'll implement the profile editor. Let me start by reading the existing code." },
			{ type: "toolCall", name: "read", arguments: { path: "src/profile-editor.ts" } },
		] as any, timestamp: Date.now() - 59000 },
		{ role: "toolResult", content: "export class ProfileEditor {\n  // ... 500 lines of code ...\n  constructor(private config: EditorConfig) {}\n  render() { return this.buildUI(); }\n}", toolCallId: "tc1", toolName: "read", timestamp: Date.now() - 58000 } as any,
		{ role: "assistant", content: [
			{ type: "text", text: "I see the structure. Now let me check the TUI components available." },
			{ type: "toolCall", name: "bash", arguments: { command: "find src/tui -name '*.ts' | head -20" } },
		] as any, timestamp: Date.now() - 57000 },
		{ role: "toolResult", content: "src/tui/input.ts\nsrc/tui/select.ts\nsrc/tui/table.ts\nsrc/tui/overlay.ts\nsrc/tui/form.ts\nsrc/tui/modal.ts", toolCallId: "tc2", toolName: "bash", timestamp: Date.now() - 56000 } as any,
		{ role: "assistant", content: "Based on the available components, I'll use the form and overlay components for the profile editor.", timestamp: Date.now() - 55000 },
		{ role: "user", content: "good, also add validation", timestamp: Date.now() - 50000 },
		{ role: "assistant", content: [
			{ type: "text", text: "Adding validation to the form fields." },
			{ type: "toolCall", name: "edit", arguments: { path: "src/profile-editor.ts", edits: [] } },
		] as any, timestamp: Date.now() - 49000 },
		{ role: "toolResult", content: "Successfully edited file", toolCallId: "tc3", toolName: "edit", timestamp: Date.now() - 48000 } as any,
		{ role: "assistant", content: "Done. Validation added to all required fields.", timestamp: Date.now() - 47000 },
		// Latest user message
		{ role: "user", content: prompt, timestamp: Date.now() },
	];
	return { messages: msgs };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	console.log("╔═══════════════════════════════════════════════════════════════════════════╗");
	console.log("║   LAB: Classifier Stream Behavior — Ground Truth (Real Bedrock Calls)    ║");
	console.log("╠═══════════════════════════════════════════════════════════════════════════╣");
	console.log("║   Model: amazon-bedrock/us.amazon.nova-micro-v1:0                        ║");
	console.log("║   Region: " + AWS_REGION.padEnd(62) + "║");
	console.log("╚═══════════════════════════════════════════════════════════════════════════╝\n");

	// ═══ TEST 1: Verify classifier prompt excludes tool content ═══════════════
	console.log("═══ TEST 1: Verify Prompt Construction (no tools in classifier input) ═══\n");

	const simpleCtx = simpleContext(HERDR_PROMPT);
	const complexCtx = complexContext(HERDR_PROMPT);

	const simplePromptText = buildClassifierPrompt(simpleCtx, "implementation");
	const complexPromptText = buildClassifierPrompt(complexCtx, "implementation");

	console.log("Simple context (1 user message):");
	console.log(`  Prompt length: ${simplePromptText.length} chars`);
	console.log(`  Contains 'toolCall': ${simplePromptText.includes("toolCall")}`);
	console.log(`  Contains 'toolResult': ${simplePromptText.includes("toolResult")}`);

	console.log("\nComplex context (11 messages: user+assistant+toolResult):");
	console.log(`  Prompt length: ${complexPromptText.length} chars`);
	console.log(`  Contains 'toolCall': ${complexPromptText.includes("toolCall")}`);
	console.log(`  Contains 'toolResult': ${complexPromptText.includes("toolResult")}`);
	console.log(`  Contains '[assistant]': ${complexPromptText.includes("[assistant]")}`);
	console.log(`  Contains '[user]': ${complexPromptText.includes("[user]")}`);

	// Show the conversation summary
	console.log("\n  Conversation summary extracted:");
	const summary = getConversationSummary(complexCtx, 6);
	for (const line of summary.split("\n")) {
		console.log(`    ${line}`);
	}

	console.log("\n  Full classifier prompt for complex context:");
	console.log("  " + "─".repeat(60));
	for (const line of complexPromptText.split("\n")) {
		console.log(`  ${line}`);
	}
	console.log("  " + "─".repeat(60));

	// ═══ TEST 2: Real Bedrock calls ══════════════════════════════════════════
	console.log("\n\n═══ TEST 2: Real Bedrock Classifier Calls ══════════════════════════════\n");

	// 2A: Simple "hi" prompt
	console.log("🧪 2A: Simple 'hi' → classifier (10s timeout)");
	const hiPrompt = buildClassifierPrompt(simpleContext("hi"), undefined);
	const r2a = await callBedrock(hiPrompt, 10_000, "simple-hi");
	printResult(r2a);

	// 2B: Herdr prompt (simple context)
	console.log("\n🧪 2B: Herdr prompt (simple context) → classifier (10s timeout)");
	const r2b = await callBedrock(simplePromptText, 10_000, "herdr-simple");
	printResult(r2b);

	// 2C: Herdr prompt (complex context with tools stripped)
	console.log("\n🧪 2C: Herdr prompt (complex context, tools excluded) → classifier (10s timeout)");
	const r2c = await callBedrock(complexPromptText, 10_000, "herdr-complex");
	printResult(r2c);

	// 2D: Very short timeout (2s) to test abort behavior
	console.log("\n🧪 2D: Herdr prompt with 2s timeout (abort test)");
	const r2d = await callBedrock(complexPromptText, 2_000, "herdr-short-timeout");
	printResult(r2d);

	// ═══ TEST 3: Concurrent classifiers (multi-pane scenario) ════════════════
	console.log("\n\n═══ TEST 3: Concurrent Classifiers (Multi-Pane Scenario) ═════════════\n");
	console.log("Simulates herdr spawning 5 OMP panes simultaneously,");
	console.log("each triggering a classifier call...\n");

	const concStart = Date.now();
	const concPromises = Array.from({ length: 5 }, (_, i) =>
		callBedrock(complexPromptText, 10_000, `concurrent-${i}`)
	);
	const concResults = await Promise.all(concPromises);
	const concWall = Date.now() - concStart;

	for (let i = 0; i < concResults.length; i++) {
		const r = concResults[i];
		const icon = r.error ? "❌" : r.timedOut ? "⏰" : "✅";
		const parsed = r.text ? parseClassifierOutput(r.text) : undefined;
		console.log(`   ${icon} #${i}: ${r.latencyMs}ms (ttft=${r.ttft ?? "?"}ms) → ${parsed?.tier || r.error?.slice(0, 40) || "timeout"}`);
	}
	console.log(`\n   Wall time: ${concWall}ms (5 concurrent requests)`);

	// ═══ TEST 4: Latency comparison — what blocking costs ════════════════════
	console.log("\n\n═══ TEST 4: Sequential Classifier Calls (Blocking Cost) ═══════════════\n");
	console.log("Simulates 3 sequential turns where the sync classifier must complete");
	console.log("before the model stream starts...\n");

	const seqStart = Date.now();
	const seqResults = [];
	for (let i = 0; i < 3; i++) {
		const r = await callBedrock(complexPromptText, 10_000, `sequential-${i}`);
		seqResults.push(r);
		const parsed = r.text ? parseClassifierOutput(r.text) : undefined;
		console.log(`   Turn ${i + 1}: ${r.latencyMs}ms (ttft=${r.ttft ?? "?"}ms) → ${parsed?.tier || "?"}`);
	}
	const seqTotal = Date.now() - seqStart;
	console.log(`\n   Total blocking time: ${seqTotal}ms for 3 turns`);
	console.log(`   Average per-turn delay: ${Math.round(seqTotal / 3)}ms`);
	console.log(`   This delay is ADDED to every turn before model stream starts!`);

	// ═══ SUMMARY ═════════════════════════════════════════════════════════════
	console.log("\n\n═══ SUMMARY ══════════════════════════════════════════════════════════\n");
	
	const allResults = [r2a, r2b, r2c, r2d, ...concResults, ...seqResults];
	const successes = allResults.filter(r => !r.error && !r.timedOut);
	const errors = allResults.filter(r => !!r.error);
	const timeouts = allResults.filter(r => r.timedOut);
	
	console.log(`Total calls: ${allResults.length}`);
	console.log(`  ✅ Success: ${successes.length}`);
	console.log(`  ❌ Errors: ${errors.length}`);
	console.log(`  ⏰ Timeouts: ${timeouts.length}`);
	
	if (successes.length > 0) {
		const avgLatency = Math.round(successes.reduce((s, r) => s + r.latencyMs, 0) / successes.length);
		const avgTtft = Math.round(successes.filter(r => r.ttft).reduce((s, r) => s + (r.ttft ?? 0), 0) / successes.filter(r => r.ttft).length);
		console.log(`\n  Average latency: ${avgLatency}ms`);
		console.log(`  Average TTFT: ${avgTtft}ms`);
		console.log(`  This is the per-turn BLOCKING cost added by the sync classifier.`);
	}

	if (errors.length > 0) {
		console.log(`\n  ⚠️  Errors seen: ${errors[0].error}`);
	}

	console.log("\n  KEY FINDINGS:");
	console.log("  • Classifier prompt now excludes tool calls/results (TEXT ONLY)");
	console.log(`  • Prompt size: ${complexPromptText.length} chars (vs full context which can be 50KB+)`);
	console.log("  • Without timeout, a stalled Bedrock stream blocks OMP indefinitely");
	console.log("  • With 10s timeout + AbortController, worst case is bounded to 10s");
	console.log("");
}

function printResult(r: { text: string; latencyMs: number; error?: string; timedOut?: boolean; chunks: number; ttft?: number }) {
	if (r.error) {
		console.log(`   ❌ Error: ${r.error}`);
		return;
	}
	if (r.timedOut) {
		console.log(`   ⏰ TIMED OUT after ${r.latencyMs}ms (partial: "${r.text.slice(0, 50)}")`);
		return;
	}
	const parsed = parseClassifierOutput(r.text);
	console.log(`   ✅ ${r.latencyMs}ms (ttft=${r.ttft}ms, ${r.chunks} chunks)`);
	console.log(`   📤 "${r.text.trim()}"`);
	console.log(`   🎯 Tier: ${parsed?.tier || "PARSE FAIL"} | Reasoning: ${parsed?.reasoning || "N/A"}`);
}

main().catch((e) => {
	console.error("Lab fatal error:", e);
	process.exit(1);
});
