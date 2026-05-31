import type { Message } from "@api/types";

export interface ExtractOptions {
	/** Include thinking blocks (default: true) */
	includeThinking?: boolean;
	/** Include tool call representations (default: true) */
	includeToolCalls?: boolean;
	/** Separator between content parts (default: "\n") */
	separator?: string;
}

/**
 * Extract plain text from message content, handling all content part types.
 *
 * @param content - Raw message content (string or structured array)
 * @param opts - Extraction options
 * @returns Plain text representation
 *
 * @example
 * // Basic usage
 * extractMessageText(message.content)
 *
 * // Space-separated (for token counting)
 * extractMessageText(message.content, { separator: " " })
 *
 * // Exclude thinking/tool calls (for compression)
 * extractMessageText(message.content, { includeThinking: false, includeToolCalls: false })
 */
export function extractMessageText(
	content: string | Message["content"],
	opts: ExtractOptions = {},
): string {
	const {
		includeThinking = true,
		includeToolCalls = true,
		separator = "\n",
	} = opts;

	if (typeof content === "string") return content;

	return content
		.map((part) => {
			if (part.type === "text") return part.text;
			if (part.type === "thinking" && includeThinking) return part.thinking;
			if (part.type === "toolCall" && includeToolCalls)
				return `${part.name} ${JSON.stringify(part.arguments)}`;
			return "";
		})
		.filter(Boolean)
		.join(separator);
}

/**
 * Convenience wrapper for extracting text from a Message object.
 *
 * @param msg - Full message object
 * @param opts - Extraction options
 * @returns Plain text representation
 */
export function extractText(msg: Message, opts?: ExtractOptions): string {
	return extractMessageText(msg.content, opts);
}
