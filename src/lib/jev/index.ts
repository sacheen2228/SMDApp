// Jev / TypeSafe SystemOne — public surface (shadow research layer only)

export {
  getJevConfig,
  isJevCallable,
  isJevProductionInfluenceAllowed,
  redactSecrets,
  type JevConfig,
} from "./config";

export {
  callJev,
  buildJevRequest,
  DEFAULT_JEV_QUESTIONS,
  type JevClientResult,
  type JevQuestionMap,
  type JevResponseBody,
} from "./client";

export {
  buildJevContext,
  jevStatePayload,
  type JevNormalizedContext,
} from "./context";

export {
  classifyJevAnswers,
  emptyClassification,
  type JevClassification,
  type JevOptionCall,
  type JevReasonCode,
} from "./classifier";

export {
  runJevShadowEvaluation,
  maybeRecordJevShadow,
  recordJevShadowAwaited,
  appendShadowRecord,
  normalizeOptionCall,
  agreements,
  assertShadowIsInert,
  type ShadowRecord,
  type ShadowComparisonInput,
} from "./shadow";
