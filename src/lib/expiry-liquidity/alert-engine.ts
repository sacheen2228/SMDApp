// ─── Alert Engine ──────────────────────────────────────────────────────
// Manages alerts with cooldown, deduplication, and multi-channel support

export type AlertType =
  | "EXPIRY_EVENT_DETECTED"
  | "CAS_DISLOCATION"
  | "OI_UNWINDING"
  | "SHORT_COVERING"
  | "PREMIUM_ACCELERATION"
  | "IV_SHOCK"
  | "FUTURES_CONFIRMED"
  | "BREAKOUT_CONFIRMED"
  | "BREAKDOWN_CONFIRMED"
  | "MOMENTUM_EXHAUSTION"
  | "REVERSAL_RISK"
  | "DATA_QUALITY_DEGRADED"
  | "MARGIN_RISK_HIGH"
  // MCX Commodity alerts
  | "MCX_BREAKOUT"
  | "MCX_BREAKDOWN"
  | "MCX_UNUSUAL_VOLUME"
  | "MCX_OI_EXPANSION"
  | "MCX_OI_UNWINDING"
  | "MCX_SESSION_OPEN"
  | "MCX_SESSION_CLOSE"
  | "MCX_STALE_DATA"
  | "MCX_HIGH_SCORE_SETUP"
  | "MCX_TARGET_HIT"
  | "MCX_STOP_LOSS_HIT";

export interface AlertConfig {
  type: AlertType;
  enabled: boolean;
  cooldownMinutes: number;
  severity: "INFO" | "WARNING" | "CRITICAL";
  channels: ("IN_APP" | "TELEGRAM" | "EMAIL" | "WEBHOOK")[];
  condition?: string;
  threshold?: number;
}

export interface Alert {
  id: string;
  type: AlertType;
  symbol: string;
  message: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  timestamp: number;
  data: Record<string, any>;
  acknowledged: boolean;
  channels: ("IN_APP" | "TELEGRAM" | "EMAIL" | "WEBHOOK")[];
}

interface AlertEngineConfig {
  defaultCooldownMinutes: number;
  maxAlertsPerMinute: number;
  maxAlertsPerHour: number;
  defaultConfigs: Record<AlertType, AlertConfig>;
  webhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

class AlertEngine {
  private config: AlertEngineConfig;
  private alertHistory: Alert[] = [];
  private cooldownMap: Map<string, number> = new Map();
  private alertsThisMinute: number = 0;
  private alertsThisHour: number = 0;
  private lastMinuteReset: number = Date.now();
  private lastHourReset: number = Date.now();
  private callbacks: Set<(alert: Alert) => void> = new Set();

  constructor(config?: Partial<AlertEngineConfig>) {
    this.config = {
      defaultCooldownMinutes: 15,
      maxAlertsPerMinute: 10,
      maxAlertsPerHour: 100,
      defaultConfigs: {
        EXPIRY_EVENT_DETECTED: { type: "EXPIRY_EVENT_DETECTED", enabled: true, cooldownMinutes: 30, severity: "WARNING", channels: ["IN_APP", "TELEGRAM"] },
        CAS_DISLOCATION: { type: "CAS_DISLOCATION", enabled: true, cooldownMinutes: 10, severity: "WARNING", channels: ["IN_APP"] },
        OI_UNWINDING: { type: "OI_UNWINDING", enabled: true, cooldownMinutes: 15, severity: "WARNING", channels: ["IN_APP", "TELEGRAM"] },
        SHORT_COVERING: { type: "SHORT_COVERING", enabled: true, cooldownMinutes: 15, severity: "WARNING", channels: ["IN_APP", "TELEGRAM"] },
        PREMIUM_ACCELERATION: { type: "PREMIUM_ACCELERATION", enabled: true, cooldownMinutes: 10, severity: "INFO", channels: ["IN_APP"] },
        IV_SHOCK: { type: "IV_SHOCK", enabled: true, cooldownMinutes: 30, severity: "CRITICAL", channels: ["IN_APP", "TELEGRAM"] },
        FUTURES_CONFIRMATION: { type: "FUTURES_CONFIRMATION", enabled: true, cooldownMinutes: 10, severity: "WARNING", channels: ["IN_APP"] },
        BREAKOUT_CONFIRMED: { type: "BREAKOUT_CONFIRMED", enabled: true, cooldownMinutes: 20, severity: "WARNING", channels: ["IN_APP", "TELEGRAM"] },
        BREAKDOWN_CONFIRMED: { type: "BREAKDOWN_CONFIRMED", enabled: true, cooldownMinutes: 20, severity: "WARNING", channels: ["IN_APP", "TELEGRAM"] },
        MOMENTUM_EXHAUSTION: { type: "MOMENTUM_EXHAUSTION", enabled: true, cooldownMinutes: 15, severity: "WARNING", channels: ["IN_APP"] },
        REVERSAL_RISK: { type: "REVERSAL_RISK", enabled: true, cooldownMinutes: 30, severity: "CRITICAL", channels: ["IN_APP", "TELEGRAM"] },
        DATA_QUALITY_DEGRADED: { type: "DATA_QUALITY_DEGRADED", enabled: true, cooldownMinutes: 60, severity: "WARNING", channels: ["IN_APP"] },
        MARGIN_RISK_HIGH: { type: "MARGIN_RISK_HIGH", enabled: true, cooldownMinutes: 30, severity: "CRITICAL", channels: ["IN_APP", "TELEGRAM"] },
      },
      webhookUrl: undefined,
      telegramBotToken: undefined,
      telegramChatId: undefined,
      ...config,
    };
  }

  // ─── Subscribe ──────────────────────────────────────────────────────
  subscribe(callback: (alert: any) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(alert: any): void {
    this.callbacks.forEach(cb => cb(alert));
  }

  // ─── Rate Limiting ─────────────────────────────────────────────────
  private checkRateLimits(): boolean {
    const now = Date.now();

    // Reset minute counter
    if (now - this.lastMinuteReset > 60_000) {
      this.alertsThisMinute = 0;
      this.lastMinuteReset = now;
    }

    // Reset hour counter
    if (now - this.lastHourReset > 3_600_000) {
      this.alertsThisHour = 0;
      this.lastHourReset = now;
    }

    if (this.alertsThisMinute >= this.config.maxAlertsPerMinute) return false;
    if (this.alertsThisHour >= this.config.maxAlertsPerHour) return false;

    return true;
  }

  // ─── Cooldown Check ────────────────────────────────────────────────
  private isInCooldown(alertKey: string, cooldownMinutes: number): boolean {
    const lastAlert = this.cooldownMap.get(alertKey);
    if (!lastAlert) return false;
    return Date.now() - lastAlert < cooldownMinutes * 60_000;
  }

  // ─── Fire Alert ────────────────────────────────────────────────────
  fire(
    type: AlertType,
    symbol: string,
    message: string,
    severity: "INFO" | "WARNING" | "CRITICAL" = "WARNING",
    data: Record<string, any> = {}
  ): Alert | null {
    // Check if alert type is enabled
    const typeConfig = this.config.defaultConfigs[type];
    if (!typeConfig?.enabled) return null;

    // Check rate limits
    if (!this.checkRateLimits()) {
      console.warn(`[AlertEngine] Rate limit exceeded for ${type}`);
      return null;
    }

    // Check cooldown
    const alertKey = `${type}_${symbol}`;
    if (this.isInCooldown(alertKey, typeConfig.cooldownMinutes)) {
      return null;
    }

    // Create alert
    const alert: any = {
      id: `${type}_${symbol}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      symbol,
      message,
      severity,
      timestamp: Date.now(),
      data,
      acknowledged: false,
      channels: typeConfig.channels,
    };

    // Update cooldown
    this.cooldownMap.set(alertKey, Date.now());

    // Update rate limits
    this.alertsThisMinute++;
    this.alertsThisHour++;

    // Store in history
    this.alertHistory.unshift(alert);
    if (this.alertHistory.length > 1000) this.alertHistory.pop();

    // Send to channels
    this.sendToChannels(alert);

    // Notify subscribers
    this.notify(alert);

    return alert;
  }

  // ─── Send to Channels ──────────────────────────────────────────────
  private async sendToChannels(alert: any): Promise<void> {
    for (const channel of alert.channels) {
      try {
        switch (channel) {
          case "IN_APP":
            // Already handled by in-app notification system
            break;
          case "TELEGRAM":
            await this.sendTelegram(alert);
            break;
          case "EMAIL":
            await this.sendEmail(alert);
            break;
          case "WEBHOOK":
            await this.sendWebhook(alert);
            break;
        }
      } catch (error) {
        console.error(`[AlertEngine] Failed to send ${alert.type} to ${channel}:`, error);
      }
    }
  }

  private async sendTelegram(alert: any): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId) return;

    const emoji = alert.severity === "CRITICAL" ? "🚨" :
      alert.severity === "WARNING" ? "⚠️" : "ℹ️";

    const message = `${emoji} <b>${alert.type}</b>\n\n` +
      `<b>Symbol:</b> ${alert.symbol}\n` +
      `<b>Message:</b> ${alert.message}\n` +
      `<b>Severity:</b> ${alert.severity}\n` +
      `<b>Time:</b> ${new Date(alert.timestamp).toLocaleString()}\n\n` +
      (alert.data ? `<b>Data:</b> <code>${JSON.stringify(alert.data, null, 2)}</code>` : "");

    await fetch(`https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.telegramChatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  }

  private async sendEmail(alert: any): Promise<void> {
    // Would integrate with email service (SendGrid, etc.)
    console.log("[AlertEngine] Email alert:", alert);
  }

  private async sendWebhook(alert: any): Promise<void> {
    if (!this.config.webhookUrl) return;

    await fetch(this.config.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
    });
  }

  // ─── Acknowledge Alert ──────────────────────────────────────────────
  acknowledge(alertId: string): boolean {
    const alert = this.alertHistory.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      return true;
    }
    return false;
  }

  // ─── Get Alert History ─────────────────────────────────────────────
  getHistory(limit: number = 100): any[] {
    return this.alertHistory.slice(0, limit);
  }

  getUnacknowledged(): any[] {
    return this.alertHistory.filter(a => !a.acknowledged);
  }

  // ─── Get Alert Stats ───────────────────────────────────────────────
  getStats(): {
    total: number;
    unacknowledged: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    last24h: number;
  } {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    for (const alert of this.alertHistory) {
      byType[alert.type] = (byType[alert.type] || 0) + 1;
      bySeverity[alert.severity] = (bySeverity[alert.severity] || 0) + 1;
    }

    return {
      total: this.alertHistory.length,
      unacknowledged: this.alertHistory.filter(a => !a.acknowledged).length,
      byType,
      bySeverity,
      last24h: this.alertHistory.filter(a => a.timestamp > dayAgo).length,
    };
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<AlertEngineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─── Subscribe ──────────────────────────────────────────────────────
  subscribe(callback: (alert: any) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  // ─── Test Alert ─────────────────────────────────────────────────────
  testAlert(type: AlertType): any {
    return this.fire(type, "TEST", `Test alert for ${type}`, "INFO", { test: true });
  }

  // ─── Reset ──────────────────────────────────────────────────────────
  reset(): void {
    this.alertHistory = [];
    this.cooldownMap.clear();
    this.alertsThisMinute = 0;
    this.alertsThisHour = 0;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let alertEngineInstance: AlertEngine | null = null;

export function getAlertEngine(): AlertEngine {
  if (!alertEngineInstance) {
    alertEngineInstance = new AlertEngine();
  }
  return alertEngineInstance;
}

// ─── Helper: Fire Common Alerts ───────────────────────────────────────
export async function fireExpiryEvent(symbol: string, score: number, direction: string): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "EXPIRY_EVENT_DETECTED",
    symbol,
    `Expiry liquidity event detected: ${direction} (Score: ${score}/100)`,
    score >= 80 ? "WARNING" : "INFO",
    { score, direction }
  );
}

export async function fireCASDislocation(symbol: string, dislocationPct: number): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "CAS_DISLOCATION",
    symbol,
    `CAS dislocation detected: ${dislocationPct >= 0 ? "+" : ""}${dislocationPct.toFixed(2)}%`,
    Math.abs(dislocationPct) > 0.5 ? "WARNING" : "INFO",
    { dislocationPct }
  );
}

export async function fireShortCovering(symbol: string, strike: number, oiChangePct: number): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "SHORT_COVERING",
    symbol,
    `Short covering detected at strike ${strike}: OI change ${oiChangePct.toFixed(1)}%`,
    "WARNING",
    { strike, oiChangePct }
  );
}

export async function firePremiumAcceleration(symbol: string, strike: number, velocity: number): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "PREMIUM_ACCELERATION",
    symbol,
    `Premium acceleration at strike ${strike}: ${velocity.toFixed(2)} pts/min`,
    "INFO",
    { strike, velocity }
  );
}

export async function fireIVShock(symbol: string, strike: number, ivVelocity: number): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "IV_SHOCK",
    symbol,
    `IV shock at strike ${strike}: IV velocity ${ivVelocity.toFixed(2)}%/min`,
    "CRITICAL",
    { strike, ivVelocity }
  );
}

export async function fireFuturesConfirmation(symbol: string, basisPct: number): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "FUTURES_CONFIRMATION",
    symbol,
    `Futures confirmation: basis ${basisPct >= 0 ? "+" : ""}${basisPct.toFixed(2)}%`,
    "WARNING",
    { basisPct }
  );
}

export async function fireBreakoutConfirmed(symbol: string, level: number): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "BREAKOUT_CONFIRMED",
    symbol,
    `Breakout confirmed above ${level}`,
    "WARNING",
    { level }
  );
}

export async function fireMomentumExhaustion(symbol: string, signals: string[]): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "MOMENTUM_EXHAUSTION",
    symbol,
    `Momentum exhaustion detected: ${signals.join(", ")}`,
    "WARNING",
    { signals }
  );
}

export async function fireReversalRisk(symbol: string, signals: string[]): Promise<any> {
  const engine = getAlertEngine();
  return engine.fire(
    "REVERSAL_RISK",
    symbol,
    `Reversal risk detected: ${signals.join(", ")}`,
    "CRITICAL",
    { signals }
  );
}