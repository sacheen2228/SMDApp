// ─── Data Quality Engine ───────────────────────────────────────────────
// Validates data completeness, freshness, and consistency before signal generation
// Local type definitions to avoid import issues

interface DataQualityIssue {
  field: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  description: string;
  impact: string;
}

interface DataQualityReport {
  score: number;
  isUsable: boolean;
  issues: DataQualityIssue[];
  staleFields: string[];
  missingFields: string[];
  latencyMs: number;
}

class DataQualityEngine {
  private config = {
    maxStalenessMs: 60_000,
    minFieldsRequired: ['spot', 'optionChain', 'futures', 'vix', 'timestamp'],
    maxLatencyMs: 5000,
    minDataPoints: 20,
  };

  private fieldValidators: Map<string, (value: any) => { valid: boolean; issue?: DataQualityIssue }> = new Map();

  constructor(config?: Partial<typeof DataQualityEngine.prototype.config>) {
    this.config = { ...this.config, ...config };
    this.initializeValidators();
  }

  private initializeValidators(): void {
    this.fieldValidators.set('spot', (value: any) => {
      if (value === undefined || value === null) return { valid: false, issue: { field: 'spot', severity: 'CRITICAL', description: 'Spot price is missing', impact: 'Cannot calculate any signals without spot price' } };
      if (typeof value !== 'number' || isNaN(value) || value <= 0) return { valid: false, issue: { field: 'spot', severity: 'CRITICAL', description: 'Invalid spot price', impact: 'Invalid spot price corrupts all calculations' } };
      return { valid: true };
    });

    this.fieldValidators.set('optionChain', (value: any) => {
      if (!value) return { valid: false, issue: { field: 'optionChain', severity: 'CRITICAL', description: 'Option chain data missing', impact: 'Cannot calculate OI flow, IV, gamma pressure' } };
      return { valid: true };
    });

    this.fieldValidators.set('futures', (value: any) => {
      if (!value) return { valid: false, issue: { field: 'futures', severity: 'WARNING', description: 'Futures data missing', impact: 'Cannot confirm with futures' } };
      return { valid: true };
    });

    this.fieldValidators.set('vix', (value: any) => {
      if (value === undefined || value === null) return { valid: false, issue: { field: 'vix', severity: 'WARNING', description: 'VIX data missing', impact: 'Volatility regime detection impaired' } };
      if (typeof value !== 'number' || value < 0 || value > 100) return { valid: false, issue: { field: 'vix', severity: 'WARNING', description: 'Invalid VIX value', impact: 'Volatility-based adjustments unreliable' } };
      return { valid: true };
    });

    this.fieldValidators.set('timestamp', (value: any) => {
      if (!value) return { valid: false, issue: { field: 'timestamp', severity: 'CRITICAL', description: 'Timestamp missing', impact: 'Cannot determine data freshness' } };
      const age = Date.now() - value;
      if (age > 60_000) return { valid: false, issue: { field: 'timestamp', severity: 'WARNING', description: `Data is ${Math.round(age / 1000)}s old`, impact: 'Stale data may produce false signals' } };
      return { valid: true };
    });
  }

  validate(data: Record<string, any>): { score: number; isUsable: boolean; issues: DataQualityIssue[]; staleFields: string[]; missingFields: string[]; latencyMs: number } {
    const issues: DataQualityIssue[] = [];
    const staleFields: string[] = [];
    const missingFields: string[] = [];
    const latency = data.timestamp ? Date.now() - data.timestamp : Infinity;

    for (const field of ['spot', 'optionChain', 'futures', 'vix', 'timestamp']) {
      if (!(field in data) || data[field] === undefined || data[field] === null) {
        missingFields.push(field);
        issues.push({ field, severity: 'CRITICAL', description: `Required field '${field}' is missing`, impact: 'Signal generation blocked' });
      }
    }

    for (const [field, validator] of this.fieldValidators.entries()) {
      if (field in data) {
        const result = validator(data[field]);
        if (!result.valid && result.issue) {
          issues.push(result.issue);
          if (result.issue.severity === 'WARNING') staleFields.push(field);
        }
      }

    const isStale = latency > 60_000;
    let score = 100;
    for (const issue of issues) {
      if (issue.severity === 'CRITICAL') score -= 30;
      else if (issue.severity === 'WARNING') score -= 10;
      else score -= 5;
    }
    if (isStale) score -= 20;
    if (missingFields.length > 0) score -= missingFields.length * 15;
    score = Math.max(0, Math.min(100, score));
    const isUsable = score >= 50 && missingFields.length === 0;
    return { score, isUsable, issues, staleFields, missingFields, latencyMs: latency };
  }

  validateOptionChain(chain: any): { score: number; isUsable: boolean; issues: any[]; staleFields: string[]; missingFields: string[]; latencyMs: number } {
    const issues: DataQualityIssue[] = [];
    let score = 100;
    if (!chain) { issues.push({ field: 'optionChain', severity: 'CRITICAL', description: 'Option chain is null', impact: 'All option-based signals blocked' }); score = 0; }
    else {
      if (!chain.strikes || chain.strikes.length === 0) { issues.push({ field: 'strikes', severity: 'CRITICAL', description: 'No strikes in chain', impact: 'No option data' }); score -= 30; }
      const now = Date.now();
      for (const strike of chain.strikes || []) { if (strike.ce?.ltp === 0 && strike.pe?.ltp === 0) { issues.push({ field: `strike_${strike.strike}`, severity: 'WARNING', description: 'Both CE and PE have zero LTP', impact: 'Strike may be illiquid or data stale' }); score -= 5; } }
      if (!chain.atmStrike || chain.atmStrike <= 0) { issues.push({ field: 'atmStrike', severity: 'WARNING', description: 'ATM strike not identified', impact: 'Cannot identify ATM options' }); score -= 10; }
      if (chain.pcr === undefined || chain.pcr === null) { issues.push({ field: 'pcr', severity: 'WARNING', description: 'PCR not calculated', impact: 'Put-call ratio unavailable' }); score -= 5; }
    }
    return { score: Math.max(0, Math.min(100, score)), isUsable: score >= 50, issues, staleFields: [], missingFields: [], latencyMs: 0 };
  }

  validateFutures(futures: any): { score: number; isUsable: boolean; issues: DataQualityIssue[]; staleFields: string[]; missingFields: string[]; latencyMs: number } {
    const issues: DataQualityIssue[] = []; let score = 100;
    if (!futures) { issues.push({ field: 'futures', severity: 'WARNING', description: 'Futures data missing', impact: 'Cannot confirm with futures' }); score = 50; }
    else {
      if (!futures.futures || futures.futures <= 0) { issues.push({ field: 'futures.price', severity: 'WARNING', description: 'Invalid futures price', impact: 'Basis calculation unreliable' }); score -= 15; }
      if (futures.oi === undefined || futures.oi === null) { issues.push({ field: 'futures.oi', severity: 'WARNING', description: 'Futures OI missing', impact: 'OI state classification impossible' }); score -= 10; }
      if (futures.basis === undefined || futures.basis === null) { issues.push({ field: 'futures.basis', severity: 'WARNING', description: 'Basis not calculated', impact: 'Cannot measure futures dislocation' }); score -= 10; }
    }
    return { score: Math.max(0, Math.min(100, score)), isUsable: score >= 50, issues, staleFields: [], missingFields: [], latencyMs: 0 };
  }

  validateMarketBreadth(breadth: any): { score: number; isUsable: boolean; issues: DataQualityIssue[]; staleFields: string[]; missingFields: string[]; latencyMs: number } {
    const issues: DataQualityIssue[] = []; let score = 100;
    if (!breadth) { issues.push({ field: 'breadth', severity: 'WARNING', description: 'Market breadth data missing', impact: 'Breadth confirmation unavailable' }); score = 50; }
    else {
      if (breadth.total === undefined || breadth.total <= 0) { issues.push({ field: 'breadth.total', severity: 'WARNING', description: 'Total stocks not available', impact: 'Breadth ratios unreliable' }); score -= 15; }
      if (breadth.advances === undefined || breadth.declines === undefined) { issues.push({ field: 'breadth.advances/declines', severity: 'WARNING', description: 'Advance/decline counts missing', impact: 'Cannot calculate A/D ratio' }); score -= 15; }
    }
    return { score: Math.max(0, Math.min(100, score)), isUsable: score >= 50, issues, staleFields: [], missingFields: [], latencyMs: 0 };
  }

  validateAll(data: { spot: number; optionChain?: any; futures?: any; marketBreadth?: any; vix?: number; timestamp: number }): { overall: any; optionChain: any; futures: any; marketBreadth: any } {
    const overall = this.validate(data);
    const optionChain = data.optionChain ? this.validateOptionChain(data.optionChain) : { score: 0, isUsable: false, issues: [{ field: 'optionChain', severity: 'CRITICAL', description: 'Missing', impact: 'No option data' }], staleFields: [], missingFields: ['optionChain'], latencyMs: 0 };
    const futures = data.futures ? this.validateFutures(data.futures) : { score: 0, isUsable: false, issues: [{ field: 'futures', severity: 'WARNING', description: 'Missing', impact: 'No futures confirmation' }], staleFields: [], missingFields: ['futures'], latencyMs: 0 };
    const marketBreadth = data.marketBreadth ? this.validateMarketBreadth(data.marketBreadth) : { score: 50, isUsable: true, issues: [], staleFields: [], missingFields: [], latencyMs: 0 };
    return { overall, optionChain, futures, marketBreadth };
  }

  configure(config: Partial<{ maxStalenessMs: number; minFieldsRequired: string[]; maxLatencyMs: number; minDataPoints: number }>): void { this.config = { ...this.config, ...config }; }
}

let dataQualityEngineInstance: DataQualityEngine | null = null;
export function getDataQualityEngine(): DataQualityEngine { if (!dataQualityEngineInstance) dataQualityEngineInstance = new DataQualityEngine(); return dataQualityEngineInstance; }
export function quickQualityCheck(data: any): { ok: boolean; score: number; issues: string[] } { const engine = getDataQualityEngine(); const report = engine.validate(data); return { ok: report.isUsable, score: report.score, issues: report.issues.map((i: any) => `${i.field}: ${i.description}`) }; }

interface DataQualityIssue { field: string; severity: 'CRITICAL' | 'WARNING' | 'INFO'; description: string; impact: string; }
interface DataQualityReport { score: number; isUsable: boolean; issues: DataQualityIssue[]; staleFields: string[]; missingFields: string[]; latencyMs: number; }