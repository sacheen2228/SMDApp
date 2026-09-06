// MarketDataManager — centralized data source orchestration
// Fallback: Breeze → Motilal → NSE → Yahoo → UNAVAILABLE

export type DataSourceName = "ICICI_BREEZE" | "MOTILAL" | "NSE" | "YAHOO" | "UNAVAILABLE";

export interface DataSourceState {
  name: DataSourceName;
  active: boolean;
  status: "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";
  lastUpdate?: Date;
  latencyMs?: number;
  error?: string;
}

export interface MarketDataPoint {
  source: DataSourceName;
  timestamp: Date;
  receivedAt: Date;
  instrument: string;
  timeframe?: string;
  freshness: "LIVE" | "FRESH" | "STALE" | "EXPIRED";
  validity: "VALID" | "INVALID" | "UNKNOWN";
  data: Record<string, any>;
}

class MarketDataManagerImpl {
  private sources = new Map<DataSourceName, DataSourceState>();
  private healthCheckInterval?: NodeJS.Timeout;

  constructor() {
    this.sources.set("ICICI_BREEZE", { name: "ICICI_BREEZE", active: false, status: "UNAVAILABLE" });
    this.sources.set("MOTILAL", { name: "MOTILAL", active: false, status: "UNAVAILABLE" });
    this.sources.set("NSE", { name: "NSE", active: false, status: "UNAVAILABLE" });
    this.sources.set("YAHOO", { name: "YAHOO", active: false, status: "UNAVAILABLE" });
  }

  getActiveSource(): DataSourceName {
    for (const [name, state] of this.sources) {
      if (state.active && state.status !== "UNAVAILABLE") return name;
    }
    return "UNAVAILABLE";
  }

  getSourceState(name: DataSourceName): DataSourceState | undefined {
    return this.sources.get(name);
  }

  getAllSources(): DataSourceState[] {
    return Array.from(this.sources.values());
  }

  updateSource(name: DataSourceName, update: Partial<DataSourceState>): void {
    const state = this.sources.get(name);
    if (state) {
      Object.assign(state, update);
      if (update.status) state.active = update.status !== "UNAVAILABLE";
    }
  }

  markLive(name: DataSourceName, latencyMs?: number): void {
    this.updateSource(name, {
      status: "LIVE",
      active: true,
      lastUpdate: new Date(),
      latencyMs,
      error: undefined,
    });
  }

  markDelayed(name: DataSourceName, reason?: string): void {
    this.updateSource(name, {
      status: "DELAYED",
      error: reason,
    });
  }

  markUnavailable(name: DataSourceName, reason?: string): void {
    this.updateSource(name, {
      status: "UNAVAILABLE",
      active: false,
      error: reason,
    });
  }

  getStatusSummary(): {
    broker: { name: string; status: string };
    dataSource: { name: string; status: string };
  } {
    const active = this.getActiveSource();
    const activeState = this.sources.get(active);

    return {
      broker: {
        name: active,
        status: activeState?.status || "UNAVAILABLE",
      },
      dataSource: {
        name: active,
        status: activeState?.status || "UNAVAILABLE",
      },
    };
  }

  startHealthCheck(intervalMs: number = 30_000): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkAllSources();
    }, intervalMs);
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
  }

  private async checkAllSources(): Promise<void> {
    // Check Yahoo Finance (always available)
    try {
      const start = Date.now();
      const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1d&interval=1m", {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        this.markLive("YAHOO", Date.now() - start);
      } else {
        this.markUnavailable("YAHOO", `HTTP ${res.status}`);
      }
    } catch (error: any) {
      this.markUnavailable("YAHOO", error.message);
    }
  }
}

export const marketDataManager = new MarketDataManagerImpl();

// ── Data Quality Engine ──
export interface DataQualityCheck {
  field: string;
  status: "LIVE" | "STALE" | "MISSING" | "INVALID";
  message?: string;
  lastUpdated?: Date;
}

export class DataQualityEngine {
  private freshnessThresholdMs = 5 * 60 * 1000; // 5 minutes = stale

  validate(point: MarketDataPoint): DataQualityCheck[] {
    const checks: DataQualityCheck[] = [];

    // Timestamp validation
    const now = Date.now();
    const pointTime = point.timestamp.getTime();
    const age = now - pointTime;

    if (age < 0) {
      checks.push({ field: "timestamp", status: "INVALID", message: "Future timestamp" });
    } else if (age > this.freshnessThresholdMs * 6) {
      checks.push({ field: "timestamp", status: "STALE", message: `Data is ${Math.round(age / 60000)} min old` });
    } else {
      checks.push({ field: "timestamp", status: "LIVE" });
    }

    // Source validation
    if (point.source === "UNAVAILABLE") {
      checks.push({ field: "source", status: "MISSING", message: "No data source available" });
    } else {
      checks.push({ field: "source", status: "LIVE", message: point.source });
    }

    // Data field validation
    for (const [key, value] of Object.entries(point.data)) {
      if (value === null || value === undefined) {
        checks.push({ field: key, status: "MISSING", message: `${key} is null/undefined` });
      } else if (typeof value === "number") {
        if (value < 0 && key !== "pnl" && key !== "changePct") {
          checks.push({ field: key, status: "INVALID", message: `Negative ${key}: ${value}` });
        } else if (value === 0 && ["ltp", "spot", "premium"].includes(key)) {
          checks.push({ field: key, status: "MISSING", message: `${key} is zero — likely unavailable` });
        }
      }
    }

    return checks;
  }

  isTradeable(checks: DataQualityCheck[]): { tradeable: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const criticalFields = ["timestamp", "source"];

    for (const check of checks) {
      if (criticalFields.includes(check.field) && check.status === "MISSING") {
        reasons.push(`${check.field}: ${check.message}`);
      }
      if (criticalFields.includes(check.field) && check.status === "INVALID") {
        reasons.push(`${check.field}: ${check.message}`);
      }
    }

    // Check for missing critical data fields
    const missingData = checks.filter(c =>
      ["ltp", "spot", "premium"].includes(c.field) && c.status === "MISSING"
    );
    if (missingData.length > 0) {
      reasons.push(`Missing price data: ${missingData.map(m => m.field).join(", ")}`);
    }

    return { tradeable: reasons.length === 0, reasons };
  }
}

export const dataQualityEngine = new DataQualityEngine();
