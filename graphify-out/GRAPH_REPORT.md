# Graph Report - omp-model-router  (2026-06-03)

## Corpus Check
- 109 files · ~210,345 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 516 nodes · 710 edges · 24 communities detected
- Extraction: 86% EXTRACTED · 14% INFERRED · 0% AMBIGUOUS · INFERRED: 99 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]

## God Nodes (most connected - your core abstractions)
1. `RouterState` - 47 edges
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
- `main()` --calls--> `buildClassifierPrompt()`  [INFERRED]
  test/lab-classifier-stream-behavior.ts → src/calibration/classifier-utils.ts
- `main()` --calls--> `getConversationSummary()`  [INFERRED]
  test/lab-classifier-stream-behavior.ts → src/calibration/classifier-utils.ts
- `main()` --calls--> `parseClassifierOutput()`  [INFERRED]
  test/lab-classifier-stream-behavior.ts → src/calibration/classifier-utils.ts
- `printResult()` --calls--> `parseClassifierOutput()`  [INFERRED]
  test/lab-classifier-stream-behavior.ts → src/calibration/classifier-utils.ts
- `route()` --calls--> `decideRouting()`  [INFERRED]
  test/routing-optimization.test.ts → src/routing/heuristic.ts

## Communities

### Community 0 - "Community 0"
Cohesion: 0.04
Nodes (2): RouterState, makeState()

### Community 1 - "Community 1"
Cohesion: 0.09
Nodes (25): writeAndParse(), isObjectRecord(), isRouterTier(), isThinkingLevel(), loadRouterConfig(), mergeConfig(), normalizeConfig(), normalizeTierConfig() (+17 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (19): handleDebug(), handleDisable(), handleEmbargo(), handleFix(), registerCommands(), routerExtension(), handlePin(), handleProfile() (+11 more)

### Community 3 - "Community 3"
Cohesion: 0.1
Nodes (24): promoteForContextCapacity(), resolveRouting(), tierUsableCapacity(), buildKeywordMatcher(), buildRoutingDecision(), countKeywordMatches(), decideRouting(), matchesKeywords() (+16 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (25): analyzeTrace(), formatAnalysisTable(), pad(), doAnalyze(), doExport(), doImport(), doReset(), doSimulate() (+17 more)

### Community 5 - "Community 5"
Cohesion: 0.17
Nodes (2): ClassifierSettingsComponent, defaultCalibration()

### Community 6 - "Community 6"
Cohesion: 0.15
Nodes (8): buildSelectListTheme(), buildTabs(), collectModels(), costLabel(), ctxLabel(), modelMeta(), ModelPickerComponent, modelToItem()

### Community 7 - "Community 7"
Cohesion: 0.17
Nodes (15): pollClassifierResult(), runClassifierStream(), spawnClassifierAgent(), spawnViaStreamSimple(), spawnViaSubagent(), buildClassifierPrompt(), extractTextOnly(), getConversationSummary() (+7 more)

### Community 8 - "Community 8"
Cohesion: 0.16
Nodes (9): formatScopedPin(), buildStatusText(), formatCost(), getDecisionFlags(), getEffectiveThinking(), ShimmerWidget, updateStatus(), makeTierPalette() (+1 more)

### Community 9 - "Community 9"
Cohesion: 0.22
Nodes (16): applyCompression(), canCompressForModel(), compressHistory(), compressIfNeeded(), detectTOONHistoryEnd(), estimateContextTokens(), estimateMessageTokens(), extractText() (+8 more)

### Community 10 - "Community 10"
Cohesion: 0.17
Nodes (5): countFallbacks(), countTiers(), ellipsize(), ProfileListComponent, shortModel()

### Community 11 - "Community 11"
Cohesion: 0.23
Nodes (15): CALIBRATION_DIR(), cancelPendingSave(), createEmptySnapshot(), debouncedSave(), GLOBAL_FILE(), isValidGlobalSnapshot(), loadGlobalCalibration(), mergeSessionIntoGlobal() (+7 more)

### Community 12 - "Community 12"
Cohesion: 0.22
Nodes (2): buildSelectListTheme(), FallbackPickerComponent

### Community 13 - "Community 13"
Cohesion: 0.22
Nodes (1): ProfileEditorComponent

### Community 14 - "Community 14"
Cohesion: 0.19
Nodes (11): clearPending(), onSessionBranch(), onSessionStart(), spawnClassifierForTurn(), writeCompletedTrace(), writePendingAsFailed(), initSessionCalibration(), appendTraceRecord() (+3 more)

### Community 15 - "Community 15"
Cohesion: 0.42
Nodes (8): checkForUpdate(), fetchLatestVersion(), getCurrentVersion(), isDevInstall(), isNewer(), parseVersion(), readCache(), writeCache()

### Community 16 - "Community 16"
Cohesion: 0.46
Nodes (7): buildPersistedState(), isRouterPersistedState(), loadPersistentState(), persist(), persistNow(), restoreFromSession(), savePersistentState()

### Community 17 - "Community 17"
Cohesion: 0.47
Nodes (3): buildConversation(), makeAssistantMsg(), makeUserMsg()

### Community 18 - "Community 18"
Cohesion: 0.4
Nodes (2): baseInput(), makeModelRegistry()

### Community 19 - "Community 19"
Cohesion: 0.33
Nodes (1): StatusAwareError

### Community 21 - "Community 21"
Cohesion: 0.67
Nodes (2): makeState(), scopes()

### Community 23 - "Community 23"
Cohesion: 0.67
Nodes (2): createMockTheme(), renderUsageReport()

### Community 29 - "Community 29"
Cohesion: 1.0
Nodes (2): estimateContextTokens(), estimateMessageTokens()

### Community 30 - "Community 30"
Cohesion: 1.0
Nodes (2): classifyPrompt(), evaluateRoutingEffectiveness()

## Knowledge Gaps
- **Thin community `Community 0`** (52 nodes): `RouterState`, `.accumulatedCacheReadTokens()`, `.accumulatedCompressedTokens()`, `.accumulatedCost()`, `.accumulatedOriginalTokens()`, `.accumulatedTokensSaved()`, `.activateSession()`, `.classifierTurnsSinceRun()`, `.clearAllEmbargoes()`, `.compressionRequestCount()`, `.compressionTotalCompressedChars()`, `.compressionTotalOriginalChars()`, `.currentCheckpoint()`, `.debugHistory()`, `.embargoDir()`, `.embargoFilePath()`, `.embargoModel()`, `.evictStaleScopes()`, `.finalizeChildSession()`, `.frozenCompressionBlock()`, `.getActiveEmbargoes()`, `.getEmbargoTimeRemaining()`, `.getSoonestExpiry()`, `.getThinkingOverride()`, `.isEmbargoed()`, `.isStreaming()`, `.lastClassifierKey()`, `.lastClassifierVerdict()`, `.lastDecision()`, `.lastTurnTimestamp()`, `.lastUserEntryId()`, `.liftEmbargo()`, `.mergeModelCosts()`, `.modelCosts()`, `.persist()`, `.persistEmbargo()`, `.recordDecision()`, `.recordModelCost()`, `.recordRoutingDecision()`, `.restoreEmbargo()`, `.restoreFromSession()`, `.scope()`, `.setParentIfAbsent()`, `.tierCounter()`, `.totalCost()`, `.userMessagesSeen()`, `makeBranchEntry()`, `makeCtx()`, `makeState()`, `seedModelCost()`, `index.ts`, `session-rollup-reporting.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 5`** (24 nodes): `ClassifierSettingsComponent`, `.#applyInlineValue()`, `.#buildRows()`, `.constructor()`, `.#fieldChanged()`, `.#getModels()`, `.#getOriginalModels()`, `.#handleDirtyConfirm()`, `.#handleInlineInput()`, `.handleInput()`, `.#hintLine()`, `.invalidate()`, `.#isDirty()`, `.#labelFor()`, `.#openModelPicker()`, `.#openModelPickerAdd()`, `.render()`, `.#renderField()`, `.#renderModelRow()`, `.#setModels()`, `.#startInlineInput()`, `.#valueFor()`, `defaultCalibration()`, `classifier-settings.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 12`** (16 nodes): `buildSelectListTheme()`, `FallbackPickerComponent`, `.#applyFilters()`, `.constructor()`, `.#formatFooter()`, `.#formatModelLine()`, `.#getResult()`, `.#getShortName()`, `.handleInput()`, `.invalidate()`, `.#moveDown()`, `.#moveUp()`, `.#recompact()`, `.render()`, `.#toggle()`, `fallback-picker.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 13`** (16 nodes): `ProfileEditorComponent`, `.constructor()`, `.#cycleThinking()`, `.#fieldChanged()`, `.#formatValue()`, `.#handleDirtyConfirm()`, `.handleInput()`, `.#hintLine()`, `.invalidate()`, `.#isDirty()`, `.#openFallbackPicker()`, `.#openModelPicker()`, `.render()`, `.#renderRow()`, `.#renderTierHeader()`, `.#rowIndex()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 18`** (6 nodes): `baseConfig()`, `baseInput()`, `makeContext()`, `makeImageContext()`, `makeModelRegistry()`, `resolve-routing.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 19`** (6 nodes): `computeEmbargoDuration()`, `isRetryableStatus()`, `parseRetryAfterMs()`, `StatusAwareError`, `.constructor()`, `embargo.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 21`** (4 nodes): `entry()`, `makeState()`, `scopes()`, `session-rollup-completeness.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 23`** (4 nodes): `usage-format.test.ts`, `createMockTheme()`, `makeDecision()`, `renderUsageReport()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 29`** (3 nodes): `estimateContextTokens()`, `estimateMessageTokens()`, `compression-trigger.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Community 30`** (3 nodes): `classifyPrompt()`, `evaluateRoutingEffectiveness()`, `simple-routing.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `parseCanonicalModelRef()` connect `Community 1` to `Community 3`, `Community 7`?**
  _High betweenness centrality (0.116) - this node is a cross-community bridge._
- **Why does `resolveRouting()` connect `Community 3` to `Community 4`, `Community 7`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Why does `resolveProfileName()` connect `Community 1` to `Community 16`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Are the 14 inferred relationships involving `registerCommands()` (e.g. with `routerExtension()` and `handleStatus()`) actually correct?**
  _`registerCommands()` has 14 INFERRED edges - model-reasoned connections that need verification._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.09 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06 - nodes in this community are weakly interconnected._