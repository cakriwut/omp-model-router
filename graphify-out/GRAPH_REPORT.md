# Graph Report - /home/riwut/workspace/omp-model-router  (2026-06-05)

## Corpus Check
- 212 files · ~100,000 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 719 nodes · 917 edges · 45 communities detected
- Extraction: 87% EXTRACTED · 13% INFERRED · 0% AMBIGUOUS · INFERRED: 120 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Router State & Session|Router State & Session]]
- [[_COMMUNITY_Config & Test Infra|Config & Test Infra]]
- [[_COMMUNITY_Commands & Lifecycle|Commands & Lifecycle]]
- [[_COMMUNITY_Calibration Persistence|Calibration Persistence]]
- [[_COMMUNITY_Routing Heuristic|Routing Heuristic]]
- [[_COMMUNITY_Feature Architecture|Feature Architecture]]
- [[_COMMUNITY_CLI Calibration Tools|CLI Calibration Tools]]
- [[_COMMUNITY_Design Documentation|Design Documentation]]
- [[_COMMUNITY_Classifier Settings TUI|Classifier Settings TUI]]
- [[_COMMUNITY_Model Picker TUI|Model Picker TUI]]
- [[_COMMUNITY_Classifier Agent|Classifier Agent]]
- [[_COMMUNITY_UI Rendering|UI Rendering]]
- [[_COMMUNITY_Context Compression|Context Compression]]
- [[_COMMUNITY_Profile List TUI|Profile List TUI]]
- [[_COMMUNITY_Fallback Picker TUI|Fallback Picker TUI]]
- [[_COMMUNITY_Profile Editor TUI|Profile Editor TUI]]
- [[_COMMUNITY_Embargo & Pin Features|Embargo & Pin Features]]
- [[_COMMUNITY_TUI Components|TUI Components]]
- [[_COMMUNITY_Classifier Cache & Signals|Classifier Cache & Signals]]
- [[_COMMUNITY_TUI Test Helpers|TUI Test Helpers]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 97|Community 97]]
- [[_COMMUNITY_Community 98|Community 98]]

## God Nodes (most connected - your core abstractions)
1. `RouterState` - 49 edges
2. `ClassifierSettingsComponent` - 22 edges
3. `ProfileEditorComponent` - 16 edges
4. `registerCommands()` - 15 edges
5. `ModelPickerComponent` - 15 edges
6. `resolveRouting()` - 14 edges
7. `FallbackPickerComponent` - 14 edges
8. `decideRouting()` - 12 edges
9. `ProfileListComponent` - 12 edges
10. `updateStatus()` - 11 edges

## Surprising Connections (you probably didn't know these)
- `extractText()` --calls--> `extractMessageText()`  [INFERRED]
  src/context-compression.ts → /home/riwut/workspace/omp-model-router/src/utils/messages.ts
- `Intelligent Routing with Tier-Based Selection` --depends_on--> `Failure Streak Tracking`  [INFERRED]
  AGENTS.md → AUTO_UPGRADE_FEATURE.md
- `resolveEffectivePin()` --calls--> `updateStatus()`  [INFERRED]
  /home/riwut/workspace/omp-model-router/src/routing/pin.ts → /home/riwut/workspace/omp-model-router/src/ui/status.ts
- `Adaptive Calibration` --rationale_for--> `Adaptive Mode Classifier Silent Failure Fix`  [EXTRACTED]
  AGENTS.md → docs/ADAPTIVE_CLASSIFIER_FIX.md
- `Debug Logging` --depends_on--> `Adaptive Mode Classifier Silent Failure Fix`  [INFERRED]
  AGENTS.md → docs/ADAPTIVE_CLASSIFIER_FIX.md

## Communities

### Community 0 - "Router State & Session"
Cohesion: 0.04
Nodes (2): RouterState, makeState()

### Community 1 - "Config & Test Infra"
Cohesion: 0.08
Nodes (27): writeAndParse(), isObjectRecord(), isRouterTier(), isThinkingLevel(), isUnsafeClassifier(), loadRouterConfig(), mergeConfig(), normalizeConfig() (+19 more)

### Community 2 - "Commands & Lifecycle"
Cohesion: 0.06
Nodes (19): handleDebug(), handleDisable(), handleEmbargo(), handleFix(), registerCommands(), routerExtension(), handlePin(), handleProfile() (+11 more)

### Community 3 - "Calibration Persistence"
Cohesion: 0.09
Nodes (27): CALIBRATION_DIR(), cancelPendingSave(), createEmptySnapshot(), debouncedSave(), GLOBAL_FILE(), isValidGlobalSnapshot(), loadGlobalCalibration(), mergeSessionIntoGlobal() (+19 more)

### Community 4 - "Routing Heuristic"
Cohesion: 0.1
Nodes (24): promoteForContextCapacity(), resolveRouting(), tierUsableCapacity(), buildKeywordMatcher(), buildRoutingDecision(), countKeywordMatches(), decideRouting(), matchesKeywords() (+16 more)

### Community 5 - "Feature Architecture"
Cohesion: 0.07
Nodes (33): Classifier Cache System, Clean Break on Pin Decay (clear lastDecision), Compression Metrics Rollup, Configuration System, Corroboration Gate for Weak Keywords, Corroboration Requirement for Weak Keywords, Cost-Optimized Heuristic, Default Pin Configuration (+25 more)

### Community 6 - "CLI Calibration Tools"
Cohesion: 0.12
Nodes (25): analyzeTrace(), formatAnalysisTable(), pad(), doAnalyze(), doExport(), doImport(), doReset(), doSimulate() (+17 more)

### Community 7 - "Design Documentation"
Cohesion: 0.08
Nodes (30): Adaptive Mode Classifier Silent Failure Fix, Adaptive Calibration, Budget Tracking and Session Management, Calibration Modes (telemetry vs adaptive), Classifier Prompt Cache, Cost-Optimized Model Routing, Debug Logging, Model Fallback Chain (+22 more)

### Community 8 - "Classifier Settings TUI"
Cohesion: 0.17
Nodes (2): ClassifierSettingsComponent, defaultCalibration()

### Community 9 - "Model Picker TUI"
Cohesion: 0.15
Nodes (8): buildSelectListTheme(), buildTabs(), collectModels(), costLabel(), ctxLabel(), modelMeta(), ModelPickerComponent, modelToItem()

### Community 10 - "Classifier Agent"
Cohesion: 0.17
Nodes (15): pollClassifierResult(), runClassifierStream(), spawnClassifierAgent(), spawnViaStreamSimple(), spawnViaSubagent(), buildClassifierPrompt(), extractTextOnly(), getConversationSummary() (+7 more)

### Community 11 - "UI Rendering"
Cohesion: 0.16
Nodes (9): formatScopedPin(), buildStatusText(), formatCost(), getDecisionFlags(), getEffectiveThinking(), ShimmerWidget, updateStatus(), makeTierPalette() (+1 more)

### Community 12 - "Context Compression"
Cohesion: 0.22
Nodes (16): applyCompression(), canCompressForModel(), compressHistory(), compressIfNeeded(), detectTOONHistoryEnd(), estimateContextTokens(), estimateMessageTokens(), extractText() (+8 more)

### Community 13 - "Profile List TUI"
Cohesion: 0.17
Nodes (5): countFallbacks(), countTiers(), ellipsize(), ProfileListComponent, shortModel()

### Community 14 - "Fallback Picker TUI"
Cohesion: 0.22
Nodes (2): buildSelectListTheme(), FallbackPickerComponent

### Community 15 - "Profile Editor TUI"
Cohesion: 0.22
Nodes (1): ProfileEditorComponent

### Community 16 - "Embargo & Pin Features"
Cohesion: 0.14
Nodes (15): /router embargo Subcommand, Embargo Cooldown Configuration, Embargo State Map Persistence, LLM Evaluation Layer for Routing, Embargo-Aware Fallback Chain, Word-Boundary Keyword Matching, Pin Pressure Lapse Mechanism, Rate Limit Embargo Feature (+7 more)

### Community 17 - "TUI Components"
Cohesion: 0.19
Nodes (13): Atomic Transactions for Profile Changes, Fallback Picker Component, Fallback Picker Component, Model Picker Component, Model Picker Component, Profile Editor TUI Component, Profile Editor Screen UI, Profile List Component (+5 more)

### Community 18 - "Classifier Cache & Signals"
Cohesion: 0.19
Nodes (13): Bucket Dominance Algorithm, Cache Invalidation Edge Cases, Classifier Cache Signature Key, Cache TTL Gate Logic, Calibration Matrix Learning, Classifier Prompt Cache Phase 1, Classifier Tool-Mix Signal Phase 2, Context Capacity Promotion (+5 more)

### Community 19 - "TUI Test Helpers"
Cohesion: 0.18
Nodes (6): createComponent(), makeEditor(), makeProfile(), rendered(), setup(), makeTheme()

### Community 20 - "Community 20"
Cohesion: 0.31
Nodes (9): appendDebugEntry(), buildPersistedState(), debugFilePath(), isRouterPersistedState(), loadPersistentState(), persist(), persistNow(), restoreFromSession() (+1 more)

### Community 21 - "Community 21"
Cohesion: 0.2
Nodes (11): Adaptive Mode (Classifier), Bedrock Inference Profiles, Classifier Fallback Chains, Classifier Model Configuration, 3x3 Confusion Matrix, Model Fallback Chains, Fallback Investigation Report, Global Calibration Snapshot (+3 more)

### Community 22 - "Community 22"
Cohesion: 0.42
Nodes (8): checkForUpdate(), fetchLatestVersion(), getCurrentVersion(), isDevInstall(), isNewer(), parseVersion(), readCache(), writeCache()

### Community 23 - "Community 23"
Cohesion: 0.33
Nodes (7): Checkpoint Expiry Threshold, Context Bloat with Frozen Checkpoint, TOON History Detection Helper, Context Token Estimation, Session Loop Investigation, TOON Compression Progressive Mode, TOON History Exclusion Fix

### Community 24 - "Community 24"
Cohesion: 0.47
Nodes (3): buildConversation(), makeAssistantMsg(), makeUserMsg()

### Community 25 - "Community 25"
Cohesion: 0.4
Nodes (2): baseInput(), makeModelRegistry()

### Community 26 - "Community 26"
Cohesion: 0.33
Nodes (1): StatusAwareError

### Community 27 - "Community 27"
Cohesion: 0.53
Nodes (4): makeBaseDecision(), makeConfig(), makeExtCtx(), makeState()

### Community 28 - "Community 28"
Cohesion: 0.33
Nodes (6): Accumulated Metrics (session-scoped), Cache Expiry Compression Trigger, Compression State Persistence, Last Turn Timestamp Field, Session Metrics Display Fix, Session Restore from Disk

### Community 29 - "Community 29"
Cohesion: 0.33
Nodes (6): In-Memory vs JSONL Data Source Preference, handleUsage Command, Session Parent Link Attribution, Header-Based Parent Attribution, Session Rollup Completeness, Session Rollup Reporting

### Community 30 - "Community 30"
Cohesion: 0.5
Nodes (5): Early Compression Bug Fix, FALLBACK_CONFIG, History Compression (TOON), Progressive Compression Configuration, RTK Integration (Token Killer)

### Community 32 - "Community 32"
Cohesion: 0.67
Nodes (2): makeState(), scopes()

### Community 34 - "Community 34"
Cohesion: 0.67
Nodes (2): createMockTheme(), renderUsageReport()

### Community 36 - "Community 36"
Cohesion: 0.5
Nodes (4): Dev Install Detection, File Dependency Installation, NPM Package Source Matching, /router update Command Fix

### Community 37 - "Community 37"
Cohesion: 0.5
Nodes (4): Calibration Telemetry Mode, Async Classifier Spawning, Calibration Trace File Format, Calibration Verification Guide

### Community 38 - "Community 38"
Cohesion: 0.5
Nodes (4): Code Deduplication, Message Text Module, Test Helper Centralization, Unified Text Extraction

### Community 44 - "Community 44"
Cohesion: 1.0
Nodes (2): estimateContextTokens(), estimateMessageTokens()

### Community 45 - "Community 45"
Cohesion: 1.0
Nodes (2): classifyPrompt(), evaluateRoutingEffectiveness()

### Community 49 - "Community 49"
Cohesion: 1.0
Nodes (3): Debug Log Management, Session JSONL Logging, Session State Persistence

### Community 50 - "Community 50"
Cohesion: 0.67
Nodes (3): Smoke Test Consolidation Guide, Tier Label Display Fix, Usage Report Rendering Logic

### Community 67 - "Community 67"
Cohesion: 1.0
Nodes (2): Checkpoint Expiry, Compression Cache Management

### Community 68 - "Community 68"
Cohesion: 1.0
Nodes (2): RouterPersistedState Interface, Session-Scoped Metrics Fix

### Community 69 - "Community 69"
Cohesion: 1.0
Nodes (2): Bucket Categorization, Cache Key Extension

### Community 97 - "Community 97"
Cohesion: 1.0
Nodes (1): Classifier Tool-Mix Signal Feature

### Community 98 - "Community 98"
Cohesion: 1.0
Nodes (1): Session-Scoped Storage Pattern

## Knowledge Gaps
- **37 isolated node(s):** `Tool-Mix Bucket Signal`, `RTK Integration for Token Savings`, `Budget Tracking and Session Management`, `Config Field Preservation Pattern`, `Session-Scoped Calibration State` (+32 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Router State & Session`** (53 nodes): `RouterState`, `.accumulatedCacheReadTokens()`, `.accumulatedCompressedTokens()`, `.accumulatedCost()`, `.accumulatedOriginalTokens()`, `.accumulatedTokensSaved()`, `.activateSession()`, `.classifierTurnsSinceRun()`, `.clearAllEmbargoes()`, `.compressionRequestCount()`, `.compressionTotalCompressedChars()`, `.compressionTotalOriginalChars()`, `.currentCheckpoint()`, `.debugHistory()`, `.embargoDir()`, `.embargoFilePath()`, `.embargoModel()`, `.evictStaleScopes()`, `.finalizeChildSession()`, `.frozenCompressionBlock()`, `.getActiveEmbargoes()`, `.getEmbargoTimeRemaining()`, `.getSoonestExpiry()`, `.getThinkingOverride()`, `.isEmbargoed()`, `.isStreaming()`, `.lastAsyncClassifierKey()`, `.lastClassifierKey()`, `.lastClassifierVerdict()`, `.lastDecision()`, `.lastTurnTimestamp()`, `.lastUserEntryId()`, `.liftEmbargo()`, `.mergeModelCosts()`, `.modelCosts()`, `.persist()`, `.persistEmbargo()`, `.recordModelCost()`, `.recordRoutingDecision()`, `.restoreEmbargo()`, `.restoreFromSession()`, `.scope()`, `.setParentIfAbsent()`, `.tierCounter()`, `.totalCost()`, `.totalTokens()`, `.userMessagesSeen()`, `makeBranchEntry()`, `makeCtx()`, `makeState()`, `seedModelCost()`, `index.ts`, `session-rollup-reporting.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Classifier Settings TUI`** (24 nodes): `ClassifierSettingsComponent`, `.#applyInlineValue()`, `.#buildRows()`, `.constructor()`, `.#fieldChanged()`, `.#getModels()`, `.#getOriginalModels()`, `.#handleDirtyConfirm()`, `.#handleInlineInput()`, `.handleInput()`, `.#hintLine()`, `.invalidate()`, `.#isDirty()`, `.#labelFor()`, `.#openModelPicker()`, `.#openModelPickerAdd()`, `.render()`, `.#renderField()`, `.#renderModelRow()`, `.#setModels()`, `.#startInlineInput()`, `.#valueFor()`, `defaultCalibration()`, `classifier-settings.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Fallback Picker TUI`** (16 nodes): `buildSelectListTheme()`, `FallbackPickerComponent`, `.#applyFilters()`, `.constructor()`, `.#formatFooter()`, `.#formatModelLine()`, `.#getResult()`, `.#getShortName()`, `.handleInput()`, `.invalidate()`, `.#moveDown()`, `.#moveUp()`, `.#recompact()`, `.render()`, `.#toggle()`, `fallback-picker.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Profile Editor TUI`** (16 nodes): `ProfileEditorComponent`, `.constructor()`, `.#cycleThinking()`, `.#fieldChanged()`, `.#formatValue()`, `.#handleDirtyConfirm()`, `.handleInput()`, `.#hintLine()`, `.invalidate()`, `.#isDirty()`, `.#openFallbackPicker()`, `.#openModelPicker()`, `.render()`, `.#renderRow()`, `.#renderTierHeader()`, `.#rowIndex()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 25`** (6 nodes): `baseConfig()`, `baseInput()`, `makeContext()`, `makeImageContext()`, `makeModelRegistry()`, `resolve-routing.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 26`** (6 nodes): `computeEmbargoDuration()`, `isRetryableStatus()`, `parseRetryAfterMs()`, `StatusAwareError`, `.constructor()`, `embargo.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 32`** (4 nodes): `entry()`, `makeState()`, `scopes()`, `session-rollup-completeness.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 34`** (4 nodes): `usage-format.test.ts`, `createMockTheme()`, `makeDecision()`, `renderUsageReport()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 44`** (3 nodes): `estimateContextTokens()`, `estimateMessageTokens()`, `compression-trigger.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 45`** (3 nodes): `classifyPrompt()`, `evaluateRoutingEffectiveness()`, `simple-routing.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 67`** (2 nodes): `Checkpoint Expiry`, `Compression Cache Management`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 68`** (2 nodes): `RouterPersistedState Interface`, `Session-Scoped Metrics Fix`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 69`** (2 nodes): `Bucket Categorization`, `Cache Key Extension`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 97`** (1 nodes): `Classifier Tool-Mix Signal Feature`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 98`** (1 nodes): `Session-Scoped Storage Pattern`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `parseCanonicalModelRef()` connect `Config & Test Infra` to `Classifier Agent`, `Routing Heuristic`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `resolveProfileName()` connect `Config & Test Infra` to `Community 20`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `RouterState` connect `Router State & Session` to `Config & Test Infra`, `Community 20`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Are the 14 inferred relationships involving `registerCommands()` (e.g. with `routerExtension()` and `handleDebug()`) actually correct?**
  _`registerCommands()` has 14 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Tool-Mix Bucket Signal`, `RTK Integration for Token Savings`, `Budget Tracking and Session Management` to the rest of the system?**
  _37 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Router State & Session` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Config & Test Infra` be split into smaller, more focused modules?**
  _Cohesion score 0.08 - nodes in this community are weakly interconnected._