// BrokerRateLimiter — centralized API rate limiting per broker
// Prevents hitting broker rate limits

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface BrokerLimits {
  requestsPerMinute: number;
  requestsPerSecond: number;
  wsSubscriptions: number;
}

const DEFAULT_LIMITS: BrokerLimits = {
  requestsPerMinute: 60,
  requestsPerSecond: 5,
  wsSubscriptions: 50,
};

class BrokerRateLimiterImpl {
  private counters = new Map<string, RateLimitEntry[]>();
  private wsSubscriptions = new Map<string, number>();

  canProceed(broker: string, limits: BrokerLimits = DEFAULT_LIMITS): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const key = broker;
    const entries = this.counters.get(key) || [];

    // Clean old entries
    const recent = entries.filter(e => e.resetAt > now);

    // Check per-second limit
    const lastSecond = recent.filter(e => e.resetAt > now - 1000);
    if (lastSecond.length >= limits.requestsPerSecond) {
      const retryAfter = lastSecond[0].resetAt - now + 100;
      return { allowed: false, retryAfterMs: retryAfter };
    }

    // Check per-minute limit
    const lastMinute = recent.filter(e => e.resetAt > now - 60_000);
    if (lastMinute.length >= limits.requestsPerMinute) {
      const retryAfter = lastMinute[0].resetAt - now + 100;
      return { allowed: false, retryAfterMs: retryAfter };
    }

    // Record this request
    recent.push({ count: 1, resetAt: now + 60_000 });
    this.counters.set(key, recent);

    return { allowed: true };
  }

  recordRequest(broker: string): void {
    const now = Date.now();
    const key = broker;
    const entries = this.counters.get(key) || [];
    entries.push({ count: 1, resetAt: now + 60_000 });
    this.counters.set(key, entries);
  }

  canSubscribe(broker: string, limits: BrokerLimits = DEFAULT_LIMITS): boolean {
    const current = this.wsSubscriptions.get(broker) || 0;
    return current < limits.wsSubscriptions;
  }

  addSubscription(broker: string): void {
    this.wsSubscriptions.set(broker, (this.wsSubscriptions.get(broker) || 0) + 1);
  }

  removeSubscription(broker: string): void {
    const current = this.wsSubscriptions.get(broker) || 0;
    this.wsSubscriptions.set(broker, Math.max(0, current - 1));
  }

  getUsage(broker: string): { requestsLastMinute: number; wsSubscriptions: number } {
    const now = Date.now();
    const entries = this.counters.get(broker) || [];
    const recent = entries.filter(e => e.resetAt > now - 60_000);

    return {
      requestsLastMinute: recent.length,
      wsSubscriptions: this.wsSubscriptions.get(broker) || 0,
    };
  }
}

export const brokerRateLimiter = new BrokerRateLimiterImpl();
