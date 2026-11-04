// Unified Engine barrel export
export { calculateDTR, calculateSessionDTR, type DtrResult, type DtrRegime } from "./dtr";
export {
  computeIndicatorBundle,
  indicatorsSufficientForTrade,
  type IndicatorBundle,
  type IndicatorRead,
  type IndicatorFreshness,
} from "./indicators";
export { readSMC, type SmcRead, type SmcStructure, type SmcEvent, type SmcZone } from "./smc";
export {
  detectMarketMechanism,
  type MechanismRead,
  type MarketMechanism,
  type ControlSide,
  type ConfirmationStatus,
} from "./mechanism";
export {
  buildDerivativesContext,
  type DerivativesContext,
  type DerivativesRead,
  type FuturesOIRead,
  type OptionChainValidation,
  type GreeksValidation,
  type OptionTradePlan,
} from "./derivatives";
export {
  buildMarketContext,
  buildMarketContextAsync,
  type MarketContext,
  type MarketContextRead,
  type VixContext,
  type FiiDiiContext,
  type SectorBreadthContext,
} from "./market-context";
export {
  coordinateDecision,
  type CoordinatorResult,
  type CoordinatorDecision,
  type ModuleEvidence,
  type ConflictDetail,
} from "./coordinator";
