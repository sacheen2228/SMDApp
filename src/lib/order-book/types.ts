/**
 * Shared shape for the Order Book snapshot.
 *
 * `bids` / `asks` are `[price, rawQuantity]` pairs, best level first.
 * Quantities are RAW broker quantities (contracts) — the UI divides by lot size.
 *
 * `ts` is the packet timestamp (ms). The API must 503 when data is older
 * than 15s or missing bids/asks/ltp — never serve stale or invented data.
 */
export interface BookSnapshot {
  ltp: number;
  expiry: string;
  low: number;
  high: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  levels: number;
  /** epoch ms of the last received packet (depth OR ltp tick) */
  ts: number;
}
