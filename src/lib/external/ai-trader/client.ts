// ═══════════════════════════════════════════════════════════════════════════
// AI-Trader HTTP Client — Connects to external AI-Trader agent systems
// ═══════════════════════════════════════════════════════════════════════════

import type { AITraderConfig, AITraderSignal, AITraderHeartbeat, AITraderTask, AITraderEvent } from './types';
import { DEFAULT_AITRADER_CONFIG } from './types';

export class AITraderClient {
  private config: AITraderConfig;
  private connected = false;
  private lastConnectionAttempt = 0;

  constructor(config: Partial<AITraderConfig> = {}) {
    this.config = { ...DEFAULT_AITRADER_CONFIG, ...config };
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T | null> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { 'X-API-Key': this.config.apiKey } : {}),
          ...options.headers,
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[AI-Trader] ${path} returned ${response.status}`);
        this.connected = false;
        return null;
      }

      this.connected = true;
      return await response.json();
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.error(`[AI-Trader] ${path} timed out after ${this.config.timeout}ms`);
      } else {
        console.error(`[AI-Trader] ${path} failed:`, error.message);
      }
      this.connected = false;
      return null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      this.connected = response.ok;
      this.lastConnectionAttempt = Date.now();
      return this.connected;
    } catch {
      this.connected = false;
      this.lastConnectionAttempt = Date.now();
      return false;
    }
  }

  async getSignals(limit = 50): Promise<AITraderSignal[]> {
    const result = await this.request<{ signals: AITraderSignal[] }>(
      `/api/signals?limit=${limit}`
    );
    return result?.signals || [];
  }

  async postSignal(signal: AITraderSignal): Promise<boolean> {
    const result = await this.request<{ ok: boolean }>(
      '/api/signals',
      { method: 'POST', body: JSON.stringify(signal) }
    );
    return result?.ok || false;
  }

  async getHeartbeats(): Promise<AITraderHeartbeat[]> {
    const result = await this.request<{ heartbeats: AITraderHeartbeat[] }>(
      '/api/agents/heartbeats'
    );
    return result?.heartbeats || [];
  }

  async getTasks(limit = 20): Promise<AITraderTask[]> {
    const result = await this.request<{ tasks: AITraderTask[] }>(
      `/api/tasks?limit=${limit}`
    );
    return result?.tasks || [];
  }

  async getEvents(since?: string, limit = 50): Promise<AITraderEvent[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (since) params.set('since', since);
    const result = await this.request<{ events: AITraderEvent[] }>(
      `/api/events?${params.toString()}`
    );
    return result?.events || [];
  }
}
