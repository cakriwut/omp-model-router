# Graph Report - /home/riwut/workspace/omp-model-router  (2026-05-31)

## Corpus Check
- 121 files · ~106,853 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 530 nodes · 845 edges · 38 communities detected
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 70 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_LLM Adaptive Calibration|LLM Adaptive Calibration]]
- [[_COMMUNITY_Session State Management|Session State Management]]
- [[_COMMUNITY_Configuration & Documentation|Configuration & Documentation]]
- [[_COMMUNITY_Classifier Decision Logic|Classifier Decision Logic]]
- [[_COMMUNITY_API Resolution & Config Update|API Resolution & Config Update]]
- [[_COMMUNITY_Prompt Cache & Compression|Prompt Cache & Compression]]
- [[_COMMUNITY_Classifier Polling & Streaming|Classifier Polling & Streaming]]
- [[_COMMUNITY_Routing Core & Optimization|Routing Core & Optimization]]
- [[_COMMUNITY_Test Utilities & Helpers|Test Utilities & Helpers]]
- [[_COMMUNITY_UI & Status Rendering|UI & Status Rendering]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Calibration Module 11|Calibration Module 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Bug Fix 15|Bug Fix 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Testing 18|Testing 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Testing 20|Testing 20]]
- [[_COMMUNITY_Testing 21|Testing 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Testing 23|Testing 23]]
- [[_COMMUNITY_Testing 24|Testing 24]]
- [[_COMMUNITY_Testing 25|Testing 25]]
- [[_COMMUNITY_Testing 26|Testing 26]]
- [[_COMMUNITY_Testing 27|Testing 27]]
- [[_COMMUNITY_Testing 28|Testing 28]]
- [[_COMMUNITY_Testing 29|Testing 29]]
- [[_COMMUNITY_Testing 30|Testing 30]]
- [[_COMMUNITY_Testing 31|Testing 31]]
- [[_COMMUNITY_Testing 32|Testing 32]]
- [[_COMMUNITY_Testing 33|Testing 33]]
- [[_COMMUNITY_Testing 34|Testing 34]]
- [[_COMMUNITY_Testing 35|Testing 35]]
- [[_COMMUNITY_Testing 36|Testing 36]]
- [[_COMMUNITY_Community 37|Community 37]]

## God Nodes (most connected - your core abstractions)
1. `RouterState` - 30 edges
2. `@cakriwut/omp-model-router` - 19 edges
3. `decideRouting()` - 13 edges
4. `updateStatus()` - 11 edges
5. `resolveRouting()` - 10 edges
6. `Model Fallback Chain` - 10 edges
7. `main()` - 9 edges
8. `parseCanonicalModelRef()` - 9 edges
9. `runCalibrate()` - 9 edges
10. `TOON Progressive History Compression` - 9 edges

## Surprising Connections (you probably didn't know these)
- `Routing Profiles (auto/deep/cheap/hybrid/oss/opus-lean/bedrock)` --references--> `cheap Profile`  [INFERRED]
  README.md → model-router.example.json
- `Routing Profiles (auto/deep/cheap/hybrid/oss/opus-lean/bedrock)` --references--> `deep Profile`  [INFERRED]
  README.md → model-router.example.json
- `@cakriwut/omp-model-router` --implements--> `Model Fallback Chain`  [EXTRACTED]
  README.md → INVESTIGATION_COMPLETE_SUMMARY.md
- `@cakriwut/omp-model-router` --implements--> `Factory Pattern with ExtensionAPI`  [EXTRACTED]
  README.md → AGENTS.md
- `docs/BEST_PRACTICES_AUDIT.md` --documents--> `@cakriwut/omp-model-router`  [EXTRACTED]
  AGENTS.md → README.md

## Communities

### Community 0 - "LLM Adaptive Calibration"
Cohesion: 0.06
Nodes (43): Adaptive LLM Calibration, Adaptive Mode (Calibration), Automatic Tier Downgrade on Budget Exceed, Bedrock Models Require Inference Profile ARNs, docs/BEST_PRACTICES_AUDIT.md, Calibration Adaptive Mode, Calibration System (Telemetry/Adaptive), Calibration Telemetry Mode (+35 more)

### Community 1 - "Session State Management"
Cohesion: 0.08
Nodes (7): Session-Scoped Metrics Bug (Stale Metrics), ensureStateDir(), isRouterPersistedState(), loadPersistentState(), RouterState, savePersistentState(), STATE_FILE()

### Community 2 - "Configuration & Documentation"
Cohesion: 0.07
Nodes (31): Auto-Upgrade Tool Threshold, Bedrock Inference Profile ARN Format Requirement, Chain Build [primary, ...fallbacks], Compression Trigger JSONL Logging, test/config-field-preservation.test.ts, Spread-Based Config Field Preservation (v0.5.2), Fallback Debug Logging, Debug Mode (debug:true) (+23 more)

### Community 3 - "Classifier Decision Logic"
Cohesion: 0.08
Nodes (30): Adaptive (confidence-based) activation, Asymmetric override (downgrade vs upgrade thresholds), cheapEval (Haiku validation gate), checkModelSupportsImage dedup, classifierModel infrastructure, containsAny() rule matcher, Corroboration gate (wordCount>=20 / why / phase / strong), decideRouting() heuristic (+22 more)

### Community 4 - "API Resolution & Config Update"
Cohesion: 0.11
Nodes (16): applyConfigUpdate(), registerCommands(), resolveConfigValue(), patchConfigFile(), routerExtension(), buildModelItems(), buildProfileItems(), CheckboxList (+8 more)

### Community 5 - "Prompt Cache & Compression"
Cohesion: 0.12
Nodes (26): Anthropic Prompt Cache (5min expiry), Cache Expiry Trigger (5min), Checkpoint Expiry Mechanism, Context Size Trigger (>=80% window), Debug Log Management Proposal, Debug Session Logging (Persistent Audit Trail), Early Compression Bug (Unconditional Trigger), FALLBACK_CONFIG Default Configuration (+18 more)

### Community 6 - "Classifier Polling & Streaming"
Cohesion: 0.21
Nodes (18): abandonClassifier(), pollClassifierResult(), runClassifierStream(), spawnClassifierAgent(), spawnViaStreamSimple(), spawnViaSubagent(), buildClassifierPrompt(), extractTextOnly() (+10 more)

### Community 7 - "Routing Core & Optimization"
Cohesion: 0.21
Nodes (20): buildKeywordMatcher(), buildRoutingDecision(), containsAny(), countKeywordMatches(), countToolResults(), countWords(), decideRouting(), extractTextFromContent() (+12 more)

### Community 8 - "Test Utilities & Helpers"
Cohesion: 0.24
Nodes (16): fakeContext(), makeRegistry(), writeAndParse(), isObjectRecord(), isRouterTier(), isThinkingLevel(), loadRouterConfig(), mergeConfig() (+8 more)

### Community 9 - "UI & Status Rendering"
Cohesion: 0.24
Nodes (14): Tier Label Display Bug (0% Tiers Shown), buildStatusText(), formatCost(), formatDecision(), formatModelRef(), formatPinSummary(), formatThinkingSummary(), getDecisionFlags() (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.23
Nodes (14): analyzeTrace(), formatAnalysisTable(), pad(), doAnalyze(), doExport(), doImport(), doReset(), doSimulate() (+6 more)

### Community 11 - "Calibration Module 11"
Cohesion: 0.28
Nodes (14): CALIBRATION_DIR(), cancelPendingSave(), createEmptySnapshot(), debouncedSave(), GLOBAL_FILE(), isValidGlobalSnapshot(), loadGlobalCalibration(), mergeSessionIntoGlobal() (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.24
Nodes (13): clearPending(), onSessionBranch(), onSessionEnd(), onSessionStart(), onTurnEnd(), onTurnStart(), spawnClassifierForTurn(), writeCompletedTrace() (+5 more)

### Community 13 - "Community 13"
Cohesion: 0.28
Nodes (12): applyCalibratedTier(), argmax(), computeAgreementRate(), computeMismatchRate(), indexToTier(), initSessionCalibration(), tierToIndex(), updateCalibrationMatrix() (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.4
Nodes (11): compressHistory(), extractText(), findSafeSplitIndex(), isModelExcludedFromCompression(), isToolRelated(), makeSyntheticAck(), mergeMessages(), resolveCompressionConfig() (+3 more)

### Community 15 - "Bug Fix 15"
Cohesion: 0.38
Nodes (10): isDevInstall() Detection, /router update Dev Install Bug, checkForUpdate(), fetchLatestVersion(), getCurrentVersion(), isDevInstall(), isNewer(), parseVersion() (+2 more)

### Community 16 - "Community 16"
Cohesion: 0.18
Nodes (11): CheckboxList component (src/tui/checkbox-list.ts), Create profile flow, Delete profile flow, handleProfile (commands.ts), patchConfigFile + reloadConfig + ensureValidActiveRouterProfile, profile-editor.ts (TUI module), Profile TUI Editor, Rename profile flow (+3 more)

### Community 17 - "Community 17"
Cohesion: 0.57
Nodes (5): buildConversation(), makeAssistantMsg(), makeAssistantWithToolCall(), makeToolResultMsg(), makeUserMsg()

### Community 18 - "Testing 18"
Cohesion: 0.52
Nodes (5): baseConfig(), baseInput(), makeContext(), makeImageContext(), makeModelRegistry()

### Community 19 - "Community 19"
Cohesion: 0.38
Nodes (1): CheckboxList

### Community 20 - "Testing 20"
Cohesion: 0.6
Nodes (4): createMockTheme(), makeDecision(), renderUsageReport(), stripAnsi()

### Community 21 - "Testing 21"
Cohesion: 0.73
Nodes (4): detectTOONHistoryEnd(), estimateContextTokens(), estimateMessageTokens(), shouldTriggerCompression()

### Community 22 - "Community 22"
Cohesion: 0.33
Nodes (6): Dev Install Detection, /router CLI Commands, /router update Command, /router usage Report, src/commands.ts, src/version-check.ts

### Community 23 - "Testing 23"
Cohesion: 0.6
Nodes (3): buildChain(), hasApiKey(), inRegistry()

### Community 24 - "Testing 24"
Cohesion: 0.67
Nodes (2): makeTheme(), stripAnsi()

### Community 25 - "Testing 25"
Cohesion: 0.67
Nodes (2): assertModelRef(), createContext()

### Community 26 - "Testing 26"
Cohesion: 0.83
Nodes (2): estimateContextTokens(), estimateMessageTokens()

### Community 27 - "Testing 27"
Cohesion: 0.67
Nodes (2): makeTheme(), stripAnsi()

### Community 28 - "Testing 28"
Cohesion: 0.83
Nodes (2): classifyPrompt(), evaluateRoutingEffectiveness()

### Community 29 - "Testing 29"
Cohesion: 0.67
Nodes (1): createMockContext()

### Community 30 - "Testing 30"
Cohesion: 0.67
Nodes (1): createFailingModelRegistry()

### Community 31 - "Testing 31"
Cohesion: 0.67
Nodes (1): createMockModelRegistry()

### Community 32 - "Testing 32"
Cohesion: 0.67
Nodes (1): simulateToolEnd()

### Community 33 - "Testing 33"
Cohesion: 0.67
Nodes (1): createMockDecision()

### Community 34 - "Testing 34"
Cohesion: 0.67
Nodes (1): createContextWithTOONHistory()

### Community 35 - "Testing 35"
Cohesion: 0.67
Nodes (1): mockExtensionContext()

### Community 36 - "Testing 36"
Cohesion: 0.67
Nodes (1): fixtureDir()

### Community 37 - "Community 37"
Cohesion: 0.67
Nodes (1): printHelp()

## Knowledge Gaps
- **61 isolated node(s):** `Oh-My-Pi`, `Manual Tier Pin Override`, `Automatic Tier Downgrade on Budget Exceed`, `Frozen Checkpoints at Turn 5`, `Smart TOON History Exclusion` (+56 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 19`** (7 nodes): `CheckboxList`, `.constructor()`, `.onInput()`, `.render()`, `.updateScrollPosition()`, `checkbox-list.ts`, `checkbox-list.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 24`** (4 nodes): `tier-label-display.test.ts`, `tier-label-display.test.ts`, `makeTheme()`, `stripAnsi()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 25`** (4 nodes): `profile-effectiveness.test.ts`, `assertModelRef()`, `createContext()`, `profile-effectiveness.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 26`** (4 nodes): `estimateContextTokens()`, `estimateMessageTokens()`, `compression-trigger.test.ts`, `compression-trigger.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 27`** (4 nodes): `usage-compression-diagnostic.test.ts`, `usage-compression-diagnostic.test.ts`, `makeTheme()`, `stripAnsi()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 28`** (4 nodes): `simple-routing.test.ts`, `classifyPrompt()`, `evaluateRoutingEffectiveness()`, `simple-routing.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 29`** (3 nodes): `session-scoped-metrics.test.ts`, `createMockContext()`, `session-scoped-metrics.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 30`** (3 nodes): `createFailingModelRegistry()`, `adaptive-mode-integration.test.ts`, `adaptive-mode-integration.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 31`** (3 nodes): `provider.test.ts`, `createMockModelRegistry()`, `provider.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 32`** (3 nodes): `simulateToolEnd()`, `auto-upgrade.test.ts`, `auto-upgrade.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 33`** (3 nodes): `createMockDecision()`, `debug-log-management.test.ts`, `debug-log-management.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 34`** (3 nodes): `toon-history-exclusion.test.ts`, `toon-history-exclusion.test.ts`, `createContextWithTOONHistory()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 35`** (3 nodes): `session-restore-compression.test.ts`, `mockExtensionContext()`, `session-restore-compression.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Testing 36`** (3 nodes): `fixtureDir()`, `calibrate.test.ts`, `calibrate.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 37`** (3 nodes): `index.ts`, `printHelp()`, `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@cakriwut/omp-model-router` connect `LLM Adaptive Calibration` to `Configuration & Documentation`, `Prompt Cache & Compression`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `parseCanonicalModelRef()` connect `Test Utilities & Helpers` to `Prompt Cache & Compression`, `Classifier Polling & Streaming`, `Routing Core & Optimization`?**
  _High betweenness centrality (0.117) - this node is a cross-community bridge._
- **Why does `resolveRouting()` connect `Routing Core & Optimization` to `Community 13`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `resolveRouting()` (e.g. with `updateCalibrationMatrix()` and `applyCalibratedTier()`) actually correct?**
  _`resolveRouting()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Oh-My-Pi`, `Manual Tier Pin Override`, `Automatic Tier Downgrade on Budget Exceed` to the rest of the system?**
  _61 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `LLM Adaptive Calibration` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._
- **Should `Session State Management` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._