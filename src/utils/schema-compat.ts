/**
 * Schema compatibility shim: converts OMP's internal schema format to standard JSON Schema.
 *
 * Background: OMP ≥0.79.x introduced a new internal schema representation for some
 * built-in tools (eval, resolve, report_tool_issue). The pi-ai provider layer (used
 * by omp-model-router) passes tool parameters directly to the OpenAI/Anthropic APIs
 * expecting valid JSON Schema. When a tool uses the internal format instead of TypeBox
 * output, the API returns HTTP 400 "Invalid schema for function '<name>'".
 *
 * This module detects and converts the internal format to valid JSON Schema so the
 * delegated streamSimple call always receives schema-compliant tool definitions.
 *
 * Internal schema shape (observed from 400-log analysis, OMP v0.79.7):
 *
 *   Object node:
 *     { domain: "object", required?: [{key, value}...], optional?: [{key, value}...] }
 *
 *   Array node:
 *     { sequence: <ObjectNode>, proto: { proto: "Array" }, minLength?: { rule: N } }
 *
 *   Enum node (string/boolean literals):
 *     { branches: [{unit: <value>, meta?: string}...] }
 *     — also appears as bare array: [{unit: <value>}...]
 *
 *   Scalar nodes:
 *     { domain: "string" }   → { type: "string" }
 *     { domain: "number" }   → { type: "number" }
 *     { domain: "boolean" }  → { type: "boolean" }
 *
 *   Record/index node (string-keyed map with typed values):
 *     { index: [{signature: "string", value: <schema>}...], domain: {...} }
 *     → { type: "object", additionalProperties: <valueSchema> }
 *
 *   All nodes may carry a `meta` string (description) that is mapped to "description".
 */

/** Detect whether a value looks like the OMP internal schema format. */
export function isInternalSchema(schema: unknown): boolean {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
	const s = schema as Record<string, unknown>;
	// TypeBox / JSON Schema always has "type" or "$schema" at the top level.
	// Internal format has "domain", "sequence", "branches", or a required[] of {key,value} pairs.
	if ("type" in s || "$schema" in s) return false;
	if ("domain" in s) return true;
	if ("sequence" in s) return true;
	if ("branches" in s) return true;
	if (Array.isArray(s["required"]) && (s["required"] as unknown[]).length > 0) {
		const first = (s["required"] as unknown[])[0];
		if (first && typeof first === "object" && !Array.isArray(first) && "key" in (first as object)) {
			return true;
		}
	}
	if (Array.isArray(s["optional"]) && (s["optional"] as unknown[]).length > 0) {
		const first = (s["optional"] as unknown[])[0];
		if (first && typeof first === "object" && !Array.isArray(first) && "key" in (first as object)) {
			return true;
		}
	}
	return false;
}

type JsonSchema = Record<string, unknown>;

/** Convert a single internal-schema node to JSON Schema. */
function convertNode(node: unknown): JsonSchema {
	// Bare array → enum of units
	if (Array.isArray(node)) {
		const units = (node as Array<{ unit?: unknown; meta?: string }>)
			.map((b) => b.unit)
			.filter((u) => u !== undefined);
		if (units.length > 0) return { enum: units };
		return {};
	}

	if (!node || typeof node !== "object") {
		// Primitive passthrough (shouldn't happen, but be safe)
		return {};
	}

	const n = node as Record<string, unknown>;
	const meta = typeof n["meta"] === "string" ? n["meta"] : undefined;

	// ── Array node ────────────────────────────────────────────────────────────
	if ("sequence" in n && n["sequence"] && typeof n["sequence"] === "object") {
		const itemSchema = convertNode(n["sequence"]);
		const result: JsonSchema = { type: "array", items: itemSchema };
		if (meta) result["description"] = meta;
		const minLen = n["minLength"];
		if (minLen && typeof minLen === "object" && "rule" in (minLen as object)) {
			result["minItems"] = (minLen as { rule: number }).rule;
		}
		return result;
	}

	// ── Enum node ─────────────────────────────────────────────────────────────
	if ("branches" in n && Array.isArray(n["branches"])) {
		const branches = n["branches"] as Array<{ unit?: unknown; meta?: string }>;
		const units = branches.map((b) => b.unit).filter((u) => u !== undefined);
		const result: JsonSchema = { enum: units };
		if (meta) result["description"] = meta;
		return result;
	}

	// ── Record/index node ─────────────────────────────────────────────────────
	if ("index" in n && Array.isArray(n["index"])) {
		const indexEntries = n["index"] as Array<{ signature?: unknown; value?: unknown }>;
		let valueSchema: JsonSchema = {};
		if (indexEntries.length > 0 && indexEntries[0].value !== undefined) {
			valueSchema = convertNode(indexEntries[0].value);
		}
		const result: JsonSchema = { type: "object", additionalProperties: valueSchema };
		if (meta) result["description"] = meta;
		return result;
	}

	// ── Object node ───────────────────────────────────────────────────────────
	if (n["domain"] === "object" || "required" in n || "optional" in n) {
		const properties: Record<string, JsonSchema> = {};
		const requiredKeys: string[] = [];

		const reqEntries = Array.isArray(n["required"])
			? (n["required"] as Array<{ key: string; value: unknown }>)
			: [];
		const optEntries = Array.isArray(n["optional"])
			? (n["optional"] as Array<{ key: string; value: unknown }>)
			: [];

		for (const entry of reqEntries) {
			if (!entry.key) continue;
			properties[entry.key] = convertNode(entry.value);
			requiredKeys.push(entry.key);
		}
		for (const entry of optEntries) {
			if (!entry.key) continue;
			properties[entry.key] = convertNode(entry.value);
		}

		const result: JsonSchema = {
			type: "object",
			properties,
		};
		if (requiredKeys.length > 0) result["required"] = requiredKeys;
		if (meta) result["description"] = meta;
		return result;
	}

	// ── Scalar nodes ──────────────────────────────────────────────────────────
	if (n["domain"] === "string") {
		const result: JsonSchema = { type: "string" };
		if (meta) result["description"] = meta;
		return result;
	}
	if (n["domain"] === "number") {
		const result: JsonSchema = { type: "number" };
		if (meta) result["description"] = meta;
		return result;
	}
	if (n["domain"] === "boolean") {
		const result: JsonSchema = { type: "boolean" };
		if (meta) result["description"] = meta;
		return result;
	}

	// Unknown shape — pass through as empty object schema to avoid API rejection
	return { type: "object" };
}

/**
 * Convert an OMP internal schema to standard JSON Schema.
 * If the schema is already valid JSON Schema (TypeBox output), returns it unchanged.
 */
export function convertToJsonSchema(schema: unknown): unknown {
	if (!isInternalSchema(schema)) return schema;
	return convertNode(schema);
}

/**
 * Sanitize a context's tool list so all tool parameters are valid JSON Schema.
 * Returns the context unchanged if no tools need conversion (zero-alloc fast path).
 */
export function sanitizeToolSchemas<T extends { tools?: Array<{ name: string; description: string; parameters: unknown }> }>(
	context: T,
): T {
	const tools = context.tools;
	if (!tools || tools.length === 0) return context;

	let needsConversion = false;
	for (const tool of tools) {
		if (isInternalSchema(tool.parameters)) {
			needsConversion = true;
			break;
		}
	}
	if (!needsConversion) return context;

	const convertedTools = tools.map((tool) => {
		if (!isInternalSchema(tool.parameters)) return tool;
		return { ...tool, parameters: convertToJsonSchema(tool.parameters) };
	});

	return { ...context, tools: convertedTools };
}
