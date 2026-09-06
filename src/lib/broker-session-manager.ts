// BrokerSessionManager — centralized session lifecycle
// Handles: connect, reconnect (exponential backoff), expiry detection, rate limiting

type ConnectionState =
  | "NOT_CONFIGURED"
  | "CONNECTING"
  | "CONNECTED"
  | "SESSION_EXPIRING"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "BROKER_ERROR";

interface SessionState {
  broker: string;
  state: ConnectionState;
  connectedAt?: Date;
  lastActivity?: Date;
  expiresAt?: Date;
  retryCount: number;
  lastError?: string;
  nextRetryAt?: Date;
}

interface BrokerCredentials {
  apiKey?: string;
  secretKey?: string;
  username?: string;
  password?: string;
  sessionToken?: string;
  dob?: string;
  vendorId?: string;
  totpKey?: string;
}

const MAX_RETRY_DELAY = 60_000; // 60 seconds max
const BASE_RETRY_DELAY = 2_000; // 2 seconds initial

class BrokerSessionManagerImpl {
  private sessions = new Map<string, SessionState>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();

  getState(broker: string): SessionState | undefined {
    return this.sessions.get(broker);
  }

  getAllStates(): Record<string, SessionState> {
    const result: Record<string, SessionState> = {};
    for (const [k, v] of this.sessions) result[k] = v;
    return result;
  }

  async connect(broker: string, creds: BrokerCredentials): Promise<{ success: boolean; error?: string }> {
    const state: SessionState = {
      broker,
      state: "CONNECTING",
      retryCount: 0,
    };
    this.sessions.set(broker, state);

    try {
      if (broker === "ICICI_BREEZE") {
        return await this.connectBreeze(creds, state);
      } else if (broker === "MOTILAL") {
        return await this.connectMotilal(creds, state);
      }
      return { success: false, error: `Unknown broker: ${broker}` };
    } catch (error: any) {
      state.state = "BROKER_ERROR";
      state.lastError = error.message;
      return { success: false, error: error.message };
    }
  }

  private async connectBreeze(creds: BrokerCredentials, state: SessionState): Promise<{ success: boolean; error?: string }> {
    // Delegate to existing Breeze auth module
    const { initBreezeSession } = await import("@/lib/icici-breeze/auth");

    const result = await initBreezeSession({
      api_key: creds.apiKey || "",
      access_token: creds.sessionToken || "",
    });

    if (result.success) {
      state.state = "CONNECTED";
      state.connectedAt = new Date();
      state.lastActivity = new Date();
      return { success: true };
    } else {
      state.state = "AUTH_ERROR";
      state.lastError = result.error || "Connection failed";
      return { success: false, error: result.error };
    }
  }

  private async connectMotilal(creds: BrokerCredentials, state: SessionState): Promise<{ success: boolean; error?: string }> {
    const { autoLogin } = await import("@/lib/motilal/auth");

    const result = await autoLogin({
      apiKey: creds.apiKey,
      secretKey: creds.secretKey,
      userId: creds.username || creds.vendorId,
      password: creds.password,
      dob: creds.dob,
      primaryIp: creds.totpKey, // repurposed for IP in env
    });

    if (result.success) {
      state.state = "CONNECTED";
      state.connectedAt = new Date();
      state.lastActivity = new Date();
      return { success: true };
    } else {
      state.state = "AUTH_ERROR";
      state.lastError = result.error || "Login failed";
      return { success: false, error: result.error };
    }
  }

  async disconnect(broker: string): Promise<void> {
    const timer = this.reconnectTimers.get(broker);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(broker);
    }

    const state = this.sessions.get(broker);
    if (state) {
      state.state = "DISCONNECTED";
    }
  }

  async testConnection(broker: string, creds: BrokerCredentials): Promise<{ success: boolean; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const result = await this.connect(broker, creds);
      const latencyMs = Date.now() - start;
      return { success: result.success, latencyMs, error: result.error };
    } catch (error: any) {
      return { success: false, latencyMs: Date.now() - start, error: error.message };
    }
  }

  // Auto-reconnect with exponential backoff
  scheduleReconnect(broker: string, getCreds: () => Promise<BrokerCredentials>): void {
    const state = this.sessions.get(broker);
    if (!state) return;

    const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, state.retryCount), MAX_RETRY_DELAY);
    state.state = "RECONNECTING";
    state.nextRetryAt = new Date(Date.now() + delay);
    state.retryCount++;

    console.log(`[BrokerSession] ${broker} reconnecting in ${delay}ms (attempt ${state.retryCount})`);

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(broker);
      const creds = await getCreds();
      const result = await this.connect(broker, creds);

      if (!result.success && state.retryCount < 10) {
        this.scheduleReconnect(broker, getCreds);
      } else if (!result.success) {
        state.state = "BROKER_ERROR";
        state.lastError = `Failed after ${state.retryCount} retries: ${result.error}`;
      }
    }, delay);

    this.reconnectTimers.set(broker, timer);
  }

  // Mark session as potentially expiring (call when data errors occur)
  markExpiring(broker: string): void {
    const state = this.sessions.get(broker);
    if (state && state.state === "CONNECTED") {
      state.state = "SESSION_EXPIRING";
      state.expiresAt = new Date();
    }
  }

  // Mark rate limited
  markRateLimited(broker: string, retryAfterMs: number): void {
    const state = this.sessions.get(broker);
    if (state) {
      state.state = "RATE_LIMITED";
      state.nextRetryAt = new Date(Date.now() + retryAfterMs);
    }
  }
}

export const brokerSessionManager = new BrokerSessionManagerImpl();
