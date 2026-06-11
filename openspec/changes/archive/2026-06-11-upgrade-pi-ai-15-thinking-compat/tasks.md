## 1. Dependency Upgrade

- [x] 1.1 Run `bun update @oh-my-pi/pi-ai @oh-my-pi/pi-agent-core @oh-my-pi/pi-coding-agent` in workspace root and verify resolved versions are `^15.11.0`
- [x] 1.2 Add `"@oh-my-pi/pi-catalog": "^15.11.0"` to `peerDependencies` in `package.json` and run `bun install` to resolve it
- [x] 1.3 Verify `bun.lock` reflects the updated versions for all four packages

## 2. Provider — Effort Clamping Guard

- [x] 2.1 In `src/provider.ts`, add import: `import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking"`
- [x] 2.2 Replace the `delegatedReasoning` construction block to call `clampThinkingLevelForModel(targetModel, effectiveThinking as Effort | undefined)` — use the clamped value instead of `effectiveThinking` directly
- [x] 2.3 Ensure the `ThinkingLevel.Off` and `ThinkingLevel.Inherit` guards remain: only call clamp when `effectiveThinking` is not `"off"` or `"inherit"`; otherwise `delegatedReasoning` stays `undefined`

## 3. Import Audit

- [x] 3.1 Search all `src/**/*.ts` files for imports from `@oh-my-pi/pi-ai/model-thinking` or `@oh-my-pi/pi-ai/effort` subpaths (these were removed in 15.6+) and update to `@oh-my-pi/pi-catalog/model-thinking` and `@oh-my-pi/pi-catalog/effort` respectively
- [x] 3.2 Verify `src/routing/heuristic.ts` compiles cleanly — `ThinkingLevel` from `@oh-my-pi/pi-agent-core` is still valid at 15.11; no import changes needed unless TypeScript errors arise
- [x] 3.3 Run `bun run check:types` (or equivalent) and resolve any TypeScript errors from the version bump

## 4. Tests

- [x] 4.1 Add unit test in `test/` for the clamping guard: mock a model with `thinking.efforts: ["low","high"]` and assert that a requested `"medium"` effort is clamped to `"low"` and `streamSimple` is called with `reasoning: "low"`
- [x] 4.2 Add unit test: mock a model with `thinking.efforts: ["minimal","low","medium","high"]` and assert `"medium"` passes through unclamped
- [x] 4.3 Add unit test: mock a model with `reasoning: false` and assert `reasoning` is omitted from stream options for any thinking level
- [x] 4.4 Run full test suite `bun run test` — all existing tests must pass

## 5. Deploy & Smoke Test

- [x] 5.1 Run `bun run deploy:dev` to install the updated extension locally
- [x] 5.2 Reload OMP (`/reload`) and confirm no startup errors
- [x] 5.3 Route a message to `amazon-bedrock/global.anthropic.claude-sonnet-4-6` at medium tier and confirm no "Thinking effort medium is not supported" error
- [x] 5.4 Verify the status widget shows the correct thinking level and the response completes successfully
