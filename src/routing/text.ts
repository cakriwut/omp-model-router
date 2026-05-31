/**
 * Text extraction utilities for routing decisions.
 * Re-exports from utils/messages.ts for stable API.
 */

import type { Context, Message } from "@oh-my-pi/pi-ai";
import {
	extractMessageText,
	getLastUserText as getLastUserTextUtil,
} from "../utils/messages.js";

export const extractTextFromContent: (
	content: string | Message["content"],
) => string = extractMessageText;

export const getLastUserText: (context: Context) => string = getLastUserTextUtil;

export const getRecentConversationText = (
	context: Context,
	limit = 6,
): string => {
	return context.messages
		.slice(-limit)
		.map((message) => extractTextFromContent(message.content).trim())
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
};

/**
 * Get recent user prompts only (for classifier context)
 * Excludes assistant responses and tool results to reduce noise
 */
export const getRecentUserText = (
	context: Context,
	limit = 4,
): string => {
	return context.messages
		.filter((message) => message.role === "user")
		.slice(-limit)
		.map((message) => extractTextFromContent(message.content).trim())
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
};

export const countToolResults = (context: Context): number => {
	return context.messages.filter((message) => message.role === "toolResult")
		.length;
};

export const countWords = (text: string): number => {
	return text.split(/\s+/).filter(Boolean).length;
};

export const hasImageAttachment = (context: Context): boolean => {
	return context.messages.some(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((part) => part.type === "image"),
	);
};
