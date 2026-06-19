/**
 * Schema compatibility shim: converts OMP's internal schema format to standard JSON Schema.
 *
 * Background: OMP ≥0.79.x switched from TypeBox to ArkType for built-in tool schemas
 * (eval, resolve, report_tool_issue, etc.). The pi-ai provider layer (used by
 * omp-model-router) was written for TypeBox and passes `tool.parameters` directly to
 * the OpenAI/Anthropic/Bedrock APIs expecting valid JSON Schema.
 *
 * Two failure modes exist:
 *
 *   1. Live ArkType `Type` instance — `tool.parameters` is a callable function. When
 *      pi-ai serializes the request body (JSON.stringify), ArkType's toJSON() emits
 *      its internal JSON AST (sequence/branches/domain/proto nodes). The API receives
 *      this non-standard format and returns HTTP 400.
 *
 *   2. ArkType JSON AST (already serialized) — same non-standard nodes as a plain
 *      object, detected by structural inspection.
 *
 * This module handles both cases:
 *   - ArkType live instances: detected via `isArkTypeInstance`, converted via
 *     `schema.toJsonSchema()` (ArkType's native JSON Schema emitter).
 *   - ArkType JSON AST objects: detected via `isInternalSchema`, converted via
 *     `arkJsonAstToWire` (ported from OMP's wire.ts).
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

/**
 * Detect whether a value is a live ArkType `Type` instance.
 * ArkType schemas are callable functions with a `toJsonSchema` method.
 * This is distinct from Zod (plain object with `_zod`) and TypeBox (plain object).
 */
export function isArkTypeInstance(schema: unknown): schema is { toJsonSchema(opts?: unknown): Record<string, unknown> } {
	return (
		typeof schema === "function" &&
		typeof (schema as Record<string, unknown>)["toJsonSchema"] === "function" &&
		typeof (schema as Record<string, unknown>)["assert"] === "function"
	);
}

/** Detect whether a value looks like the OMP internal ArkType JSON AST format. */
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

/** Convert a single ArkType JSON AST node to JSON Schema (ported from OMP wire.ts). */
function arkJsonAstToWire(node: unknown): JsonSchema {
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
		const itemSchema = arkJsonAstToWire(n["sequence"]);
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
			valueSchema = arkJsonAstToWire(indexEntries[0].value);
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
			properties[entry.key] = arkJsonAstToWire(entry.value);
			requiredKeys.push(entry.key);
		}
		for (const entry of optEntries) {
			if (!entry.key) continue;
			properties[entry.key] = arkJsonAstToWire(entry.value);
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
 * Handles three cases:
 *   1. Live ArkType `Type` instance → call toJsonSchema() then post-process
 *   2. ArkType JSON AST (plain object) → convert via arkJsonAstToWire
 *   3. Already valid JSON Schema (TypeBox/Zod output) → return unchanged
 */
export function convertToJsonSchema(schema: unknown): unknown {
	// Case 1: live ArkType instance — convert via native toJsonSchema()
	if (isArkTypeInstance(schema)) {
		try {
			const raw = schema.toJsonSchema({ target: "draft-2020-12", fallback: (ctx: { base: unknown }) => ctx.base }) as Record<string, unknown>;
			delete raw.$schema;
			postProcessSchema(raw);
			return raw;
		} catch {
			// fallback: try treating as JSON AST after schema.toJSON() serialization
			const serialized = (schema as unknown as { toJSON?(): unknown }).toJSON?.();
			if (serialized && isInternalSchema(serialized)) return arkJsonAstToWire(serialized);
			return schema;
		}
	}
	// Case 2: ArkType JSON AST (plain object)
	if (isInternalSchema(schema)) return arkJsonAstToWire(schema);
	// Case 3: already valid JSON Schema
	return schema;
}

/**
 * Post-process a converted JSON Schema:
 *  - infer missing `type` on bare enum nodes (Gemini/Vertex reject enum without type)
 *  - close declared object nodes with additionalProperties: false
 */
function postProcessSchema(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) postProcessSchema(child);
		return;
	}
	if (!node || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;

	// Infer type for bare enum (no type field)
	if (!("type" in obj) && Array.isArray(obj.enum)) {
		const types = new Set((obj.enum as unknown[]).map((v) => typeof v));
		if (types.size === 1) {
			const t = [...types][0];
			if (t === "string" || t === "number" || t === "boolean") obj.type = t;
		}
	}

	// Recurse into schema-valued positions
	for (const key of ["items", "additionalProperties", "not", "if", "then", "else"]) {
		if (key in obj) postProcessSchema(obj[key]);
	}
	for (const key of ["properties", "$defs", "definitions"]) {
		const map = obj[key];
		if (map && typeof map === "object" && !Array.isArray(map)) {
			for (const v of Object.values(map as Record<string, unknown>)) postProcessSchema(v);
		}
	}
	for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
		if (Array.isArray(obj[key])) {
			for (const child of obj[key] as unknown[]) postProcessSchema(child);
		}
	}
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
		if (isArkTypeInstance(tool.parameters) || isInternalSchema(tool.parameters)) {
			needsConversion = true;
			break;
		}
	}
	if (!needsConversion) return context;

	const convertedTools = tools.map((tool) => {
		if (!isArkTypeInstance(tool.parameters) && !isInternalSchema(tool.parameters)) return tool;
		return { ...tool, parameters: convertToJsonSchema(tool.parameters) };
	});

	return { ...context, tools: convertedTools };
}
