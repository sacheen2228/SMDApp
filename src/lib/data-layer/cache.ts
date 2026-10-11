// TtlCache — shared by all central‑data‑layer providers
// Instances are short‑lived (per‑request) or persisted via module state.
// Most callers import from '@/lib/data-layer'; this file exists for
// direct import when a value (not type) is needed.

export class TtlCache<K, V> {
  private readonly Map: Map<K, { value: V; ts: number }>;
  private readonly ttlMs: number;

  constructor(ttlMs = 5_000) {
    this.Map = new Map();
    this.ttlMs = ttlMs;
  }

  set(key: K, value: V): void {
    this.Map.set(key, { value, ts: Date.now() });
  }

  get(key: K): V | undefined {
    const entry = this.Map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.Map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.Map.get(key);
    if (!entry) return false;
    return Date.now() - entry.ts <= this.ttlMs;
  }

  delete(key: K): boolean {
    return this.Map.delete(key);
  }

  clear(): void {
    this.Map.clear();
  }
}