// Pre-Market Data Science Lab — public barrel (research only).

export * from "./types";
export * from "./calendar";
export * from "./quality";
export * from "./normalize";
export * from "./analytics";
export * from "./features";
export * from "./models";
export * from "./validation";
export * from "./score";
// storage exports shadowCoverage alias — avoid re-export clash with shadow-recorder
export {
  getLabDb, initLabSchema,
  saveCmSnapshot, saveFnoSnapshot, saveStudyDay, getStudyDay, listStudyDays,
  saveFeatures, loadFeatures, saveModelRun, listModelRuns, saveScore, getLatestScore,
  coverageStats, saveShadowSession, getShadowSession, listShadowSessions,
  saveOptionSim, listOptionSims, shadowCoverageStats, wilsonInterval,
  listPendingOutcomes, setOutcomeStatus, appendCaptureAudit, listCaptureAudit,
} from "./storage";
export * from "./fetchers";
export * from "./collector";
export * from "./opening-confirm";
export * from "./dataset";
export * from "./research-inputs";
export * from "./outcomes";
export * from "./significance";
export * from "./option-sim";
export * from "./shadow-recorder";
export * from "./shadow-compare";
export * from "./outcome-attach";
export * from "./daily-report";
export * from "./daily-pipeline";
