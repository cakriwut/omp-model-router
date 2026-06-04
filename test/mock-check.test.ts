import { mock, test, expect } from "bun:test";

mock.module("../src/calibration/index", () => ({
  spawnClassifierAgent: async () => { console.log("MOCK CALLED"); return "mock-id"; },
  pollClassifierResult: async () => ({ ready: false }),
  abandonClassifier: () => {},
  openTraceFile: () => undefined,
  appendTraceRecord: () => {},
  truncatePrompt: (s: string, n: number) => s.slice(0, n),
  cancelPendingSave: () => {},
  initSessionCalibration: () => ({ matrix: [[0,0,0],[0,0,0],[0,0,0]], totalComparisons: 0, llmCallsAttempted: 0, llmCallsFailed: 0, sessionStartTime: Date.now(), turnsProcessed: 0 }),
  loadGlobalCalibration: () => undefined,
  mergeSessionIntoGlobal: () => {},
  updateCalibrationMatrix: () => {},
}));

import { spawnClassifierForTurn } from "../src/calibration/hooks";
import { RouterState } from "../src/state";

test("mock check", async () => {
  const state = new RouterState({} as any);
  state.activateSession("s1");
  state.calibration = { matrix: [[0,0,0],[0,0,0],[0,0,0]], totalComparisons: 0, llmCallsAttempted: 0, llmCallsFailed: 0, sessionStartTime: Date.now(), turnsProcessed: 0 };
  state.lastExtensionContext = {
    modelRegistry: { find: () => ({ id: "t", provider: "t", contextWindow: 200000, cost: { input: 0.001, output: 0.003 }, input: ["text"], output: ["text"] }), getApiKey: async () => "key", getProviders: () => [], registerProvider: () => {} } as any,
    ui: { notify: () => {} } as any,
  } as any;
  state.lastDecision = { profile: "auto", tier: "medium", phase: "implementation", targetProvider: "p", targetModelId: "m", targetLabel: "l", reasoning: "r", thinking: "off", timestamp: Date.now(), syncClassifierRan: false };
  state.currentConfig = { defaultProfile: "auto", debug: false, maxSessionBudget: 5, defaultPin: "auto", pinTimeout: 600000, enableRtk: false, calibration: { enabled: true, mode: "telemetry", warmupTurns: 5, classifierModel: "x/y", overrideThreshold: 0.65, traceEnabled: false, useGlobalPrior: false, globalPriorWeight: 0.1 }, profiles: { auto: { high: { model: "a/b" }, medium: { model: "c/d" }, low: { model: "e/f" } } } };
  state.userMessagesSeen = 0;
  
  spawnClassifierForTurn(state, state.currentConfig, "medium", { messages: [{ role: "user", content: "test" }] });
  await new Promise(r => setTimeout(r, 100));
  console.log("pendingAgentId:", state.calibration?.pendingAgentId);
  console.log("lastAsyncClassifierKey:", state.lastAsyncClassifierKey);
  expect(state.lastAsyncClassifierKey).toBe("0");
});
