import { describe, it, expect } from "bun:test";
import { isArkTypeInstance, isInternalSchema, convertToJsonSchema, sanitizeToolSchemas } from "../src/utils/schema-compat";

// ─── Fixtures from real HTTP 400 logs (OMP v0.79.7) ─────────────────────────

const evalSchema = {
	required: [
		{
			key: "cells",
			value: {
				sequence: {
					required: [
						{
							key: "language",
							value: {
								branches: [
									{ unit: "js", meta: "runtime" },
									{ unit: "py", meta: "runtime" },
								],
								meta: "runtime",
							},
						},
						{
							key: "code",
							value: {
								domain: "string",
								meta: "cell body",
							},
						},
					],
					optional: [
						{
							key: "title",
							value: { domain: "string", meta: "label" },
						},
						{
							key: "timeout",
							value: { domain: "number", meta: "per-cell seconds" },
						},
						{
							key: "reset",
							value: {
								branches: [
									{ unit: false, meta: "wipe kernel" },
									{ unit: true, meta: "wipe kernel" },
								],
								meta: "wipe kernel",
							},
						},
					],
					domain: "object",
				},
				proto: { proto: "Array", meta: "cells" },
				minLength: { rule: 1, meta: "cells" },
				meta: "cells executed in order",
			},
		},
	],
	domain: "object",
};

const resolveSchema = {
	required: [
		{
			key: "action",
			value: [{ unit: "apply" }, { unit: "discard" }],
		},
		{
			key: "reason",
			value: { domain: "string", meta: "reason for action" },
		},
	],
	optional: [
		{
			key: "extra",
			value: {
				index: [{ signature: "string", value: {} }],
				domain: { domain: "object", meta: "free-form metadata" },
				meta: "free-form metadata",
			},
		},
	],
	domain: "object",
};

const reportToolIssueSchema = {
	required: [
		{
			key: "tool",
			value: {
				branches: [
					{ unit: "ask", meta: "tool name" },
					{ unit: "bash", meta: "tool name" },
					{ unit: "eval", meta: "tool name" },
				],
				meta: "tool name",
			},
		},
		{
			key: "report",
			value: { domain: "string", meta: "unexpected behavior" },
		},
	],
	domain: "object",
};

// A normal TypeBox-style JSON Schema (should pass through unchanged)
const typeboxSchema = {
	type: "object",
	properties: {
		path: { type: "string" },
	},
	required: ["path"],
	additionalProperties: false,
};

// ─── isInternalSchema ────────────────────────────────────────────────────────

describe("isInternalSchema", () => {
	it("detects eval schema as internal", () => {
		expect(isInternalSchema(evalSchema)).toBe(true);
	});

	it("detects resolve schema as internal", () => {
		expect(isInternalSchema(resolveSchema)).toBe(true);
	});

	it("detects report_tool_issue schema as internal", () => {
		expect(isInternalSchema(reportToolIssueSchema)).toBe(true);
	});

	it("rejects TypeBox schema as NOT internal", () => {
		expect(isInternalSchema(typeboxSchema)).toBe(false);
	});

	it("rejects null/undefined/primitives", () => {
		expect(isInternalSchema(null)).toBe(false);
		expect(isInternalSchema(undefined)).toBe(false);
		expect(isInternalSchema("string")).toBe(false);
		expect(isInternalSchema(42)).toBe(false);
	});
});

// ─── convertToJsonSchema ─────────────────────────────────────────────────────

describe("convertToJsonSchema – eval schema", () => {
	const result = convertToJsonSchema(evalSchema) as any;

	it("produces type: object at top level", () => {
		expect(result.type).toBe("object");
	});

	it("has required: ['cells']", () => {
		expect(result.required).toEqual(["cells"]);
	});

	it("cells is an array type with minItems: 1", () => {
		const cells = result.properties.cells;
		expect(cells.type).toBe("array");
		expect(cells.minItems).toBe(1);
	});

	it("cells items is an object type", () => {
		expect(result.properties.cells.items.type).toBe("object");
	});

	it("cells items has required: ['language', 'code']", () => {
		expect(result.properties.cells.items.required).toEqual(["language", "code"]);
	});

	it("language is an enum of ['js', 'py']", () => {
		expect(result.properties.cells.items.properties.language.enum).toEqual(["js", "py"]);
	});

	it("code is type string", () => {
		expect(result.properties.cells.items.properties.code.type).toBe("string");
	});

	it("optional: title is type string", () => {
		expect(result.properties.cells.items.properties.title.type).toBe("string");
	});

	it("optional: timeout is type number", () => {
		expect(result.properties.cells.items.properties.timeout.type).toBe("number");
	});

	it("optional: reset is enum [false, true]", () => {
		expect(result.properties.cells.items.properties.reset.enum).toEqual([false, true]);
	});

	it("title and timeout are NOT in required array", () => {
		const required = result.properties.cells.items.required ?? [];
		expect(required).not.toContain("title");
		expect(required).not.toContain("timeout");
		expect(required).not.toContain("reset");
	});
});

describe("convertToJsonSchema – resolve schema", () => {
	const result = convertToJsonSchema(resolveSchema) as any;

	it("produces type: object", () => {
		expect(result.type).toBe("object");
	});

	it("has required: ['action', 'reason']", () => {
		expect(result.required).toContain("action");
		expect(result.required).toContain("reason");
	});

	it("action is an enum of ['apply', 'discard']", () => {
		expect(result.properties.action.enum).toEqual(["apply", "discard"]);
	});

	it("reason is type string", () => {
		expect(result.properties.reason.type).toBe("string");
	});

	it("optional extra is an object (record/index node)", () => {
		expect(result.properties.extra.type).toBe("object");
	});
});

describe("convertToJsonSchema – report_tool_issue schema", () => {
	const result = convertToJsonSchema(reportToolIssueSchema) as any;

	it("produces type: object", () => {
		expect(result.type).toBe("object");
	});

	it("tool is an enum", () => {
		expect(Array.isArray(result.properties.tool.enum)).toBe(true);
		expect(result.properties.tool.enum).toContain("ask");
		expect(result.properties.tool.enum).toContain("bash");
	});

	it("report is type string", () => {
		expect(result.properties.report.type).toBe("string");
	});
});

describe("convertToJsonSchema – passthrough for JSON Schema", () => {
	it("returns TypeBox schema unchanged", () => {
		const result = convertToJsonSchema(typeboxSchema);
		expect(result).toBe(typeboxSchema); // exact same reference
	});
});

// ─── sanitizeToolSchemas ──────────────────────────────────────────────────────

describe("sanitizeToolSchemas", () => {
	it("returns context unchanged (same reference) when no internal schemas", () => {
		const ctx = {
			tools: [
				{ name: "read", description: "read a file", parameters: typeboxSchema },
				{ name: "bash", description: "run bash", parameters: typeboxSchema },
			],
		};
		expect(sanitizeToolSchemas(ctx)).toBe(ctx);
	});

	it("converts internal schema tools and leaves others intact", () => {
		const ctx = {
			tools: [
				{ name: "read", description: "read a file", parameters: typeboxSchema },
				{ name: "eval", description: "run code", parameters: evalSchema },
				{
					name: "report_tool_issue",
					description: "report issue",
					parameters: reportToolIssueSchema,
				},
			],
		};
		const result = sanitizeToolSchemas(ctx) as typeof ctx;
		expect(result).not.toBe(ctx); // new object created

		// read tool unchanged (same reference)
		expect(result.tools[0]).toBe(ctx.tools[0]);

		// eval tool converted
		const evalResult = result.tools[1].parameters as any;
		expect(evalResult.type).toBe("object");
		expect(evalResult.properties.cells.type).toBe("array");

		// report_tool_issue tool converted
		const reportResult = result.tools[2].parameters as any;
		expect(reportResult.type).toBe("object");
		expect(Array.isArray(reportResult.properties.tool.enum)).toBe(true);
	});

	it("handles context with no tools", () => {
		const ctx = { messages: [] };
		expect(sanitizeToolSchemas(ctx)).toBe(ctx);
	});

	it("handles context with empty tools array", () => {
		const ctx = { tools: [] };
		expect(sanitizeToolSchemas(ctx)).toBe(ctx);
	});
});

// ─── isArkTypeInstance ────────────────────────────────────────────────────────

describe("isArkTypeInstance", () => {
	it("detects a mock ArkType instance (callable + toJsonSchema + assert)", () => {
		const mockArk = Object.assign(() => {}, {
			toJsonSchema: () => ({}),
			assert: () => {},
		});
		expect(isArkTypeInstance(mockArk)).toBe(true);
	});

	it("rejects plain objects", () => {
		expect(isArkTypeInstance({ toJsonSchema: () => {} })).toBe(false);
	});

	it("rejects functions without toJsonSchema", () => {
		expect(isArkTypeInstance(() => {})).toBe(false);
	});

	it("rejects null/undefined/primitives", () => {
		expect(isArkTypeInstance(null)).toBe(false);
		expect(isArkTypeInstance("string")).toBe(false);
	});
});

describe("convertToJsonSchema – live ArkType instance", () => {
	it("calls toJsonSchema() and removes $schema", () => {
		const mockArk = Object.assign(() => {}, {
			toJsonSchema: (_opts?: unknown) => ({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				properties: {
					cells: {
						type: "array",
						items: {
							type: "object",
							properties: {
								language: { enum: ["py", "js"] },
								code: { type: "string" },
							},
							required: ["language", "code"],
						},
						minItems: 1,
					},
				},
				required: ["cells"],
			}),
			assert: () => {},
		});

		const result = convertToJsonSchema(mockArk) as any;
		expect(result.$schema).toBeUndefined(); // $schema stripped
		expect(result.type).toBe("object");
		expect(result.properties.cells.type).toBe("array");
		expect(result.properties.cells.minItems).toBe(1);
	});

	it("infers type on bare enum after toJsonSchema()", () => {
		const mockArk = Object.assign(() => {}, {
			toJsonSchema: () => ({
				type: "object",
				properties: {
					lang: { enum: ["py", "js"] }, // no type
				},
			}),
			assert: () => {},
		});
		const result = convertToJsonSchema(mockArk) as any;
		// postProcessSchema should add type: "string" to the bare enum
		expect(result.properties.lang.type).toBe("string");
	});
});

describe("sanitizeToolSchemas – ArkType instance tools", () => {
	it("converts ArkType instance tool parameters", () => {
		const mockArk = Object.assign(() => {}, {
			toJsonSchema: () => ({
				type: "object",
				properties: { cells: { type: "array" } },
				required: ["cells"],
			}),
			assert: () => {},
		});

		const ctx = {
			tools: [
				{ name: "read", description: "read", parameters: typeboxSchema },
				{ name: "eval", description: "eval", parameters: mockArk },
			],
		};

		const result = sanitizeToolSchemas(ctx) as typeof ctx;
		expect(result).not.toBe(ctx);
		expect(result.tools[0]).toBe(ctx.tools[0]); // unchanged
		const evalResult = result.tools[1].parameters as any;
		expect(evalResult.type).toBe("object");
		expect(evalResult.properties.cells.type).toBe("array");
	});
});
