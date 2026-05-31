/**
 * Shared message text extraction utilities.
 *
 * Consolidates three near-duplicate implementations that previously lived in
 * routing.ts, calibration/classifier-utils.ts, and context-compression.ts.
 */

import type { Context, Message } from "@oh-my-pi/pi-ai";

export interface ExtractOptions {
	/** Include `<thinking>` blocks (default: true). */
	includeThinking?: boolean;
	/** Include toolCall representations (default: true). */
	includeToolCalls?: boolean;
	/** Format used to render toolCall blocks when included (default: "args"). */
	toolCallFormat?: "args" | "name-only";
	/** Truncate the resulting string to this many characters (default: no limit). */
	maxLength?: number;
}

/**
 * Extract plain text from message content. Handles both the string and
 * structured-array shapes that `Message["content"]` can take.
 */
export function extractMessageText(
	content: string | Message["content"],
	opts: ExtractOptions = {},
): string {
	const {
		includeThinking = true,
		includeToolCalls = true,
		toolCallFormat = "args",
		maxLength,
	} = opts;

	if (typeof content === "string") {
		return maxLength !== undefined ? content.slice(0, maxLength) : content;
	}
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") {
			if (part.text) parts.push(part.text);
		} else if (part.type === "thinking" && includeThinking) {
			if (part.thinking) parts.push(part.thinking);
		} else if (part.type === "toolCall" && includeToolCalls) {
			parts.push(
				toolCallFormat === "name-only"
					? `[tool:${part.name}]`
					: `${part.name} ${JSON.stringify(part.arguments)}`,
			);
		}
	}

	const joined = parts.join("\n");
	return maxLength !== undefined ? joined.slice(0, maxLength) : joined;
}

/**
 * Extract text from a full Message object.
 */
export function extractText(msg: Message, opts?: ExtractOptions): string {
	return extractMessageText(msg.content, opts);
}

/**
 * Get the last user message text from context (trimmed).
 */
export function getLastUserText(context: Context, opts?: ExtractOptions): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "user") {
			return extractText(msg, opts).trim();
		}
	}
	return "";
}

/**
 * Get the N most recent user messages, joined by `\n---\n`.
 *
 * @deprecated Prefer `getConversationSummary` from classifier-utils for
 * classifier inputs; kept here for backward compat with legacy call sites.
 */
export function getRecentUserText(
	context: Context,
	count: number,
	opts?: ExtractOptions,
): string {
	const userMsgs: string[] = [];
	for (
		let i = context.messages.length - 1;
		i >= 0 && userMsgs.length < count;
		i--
	) {
		const msg = context.messages[i];
		if (msg.role === "user") {
			const text = extractText(msg, opts).trim();
			if (text) userMsgs.unshift(text);
		}
	}
	return userMsgs.join("\n---\n");
}
