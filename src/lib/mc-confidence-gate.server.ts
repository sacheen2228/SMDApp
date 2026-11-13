/**
 * MC confidence gate — server-only: Breeze multi-day fetch + candidate annotate.
 * NEVER import from client components (fs + Breeze auth).
 *
 * Pure MC lives in mc-confidence-gate.ts (client-safe).
 */
import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { initSession, getBreezeClient, getSessionState } from "@/lib/icici-breeze/auth";
import { resolveBreezeStockCode } from "@/lib/icici-scrip-master";
import {
  MC_CONFIG,
  monteCarloBracket,
  istDecisionMinutes,
  clampToSession,
  todayIst,
  priorDatesFrom,
  type McBar,
  type McDir,
} from "@/lib/mc-confidence-gate";

const CACHE_DIR = "data/cache/5m";
const memCache = new Map<string, { bars: McBar[]; ts: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtBreeze(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Prior-session 5m bars (Breeze multi-day, memory + disk cached). */
export async function fetchPrior5mBars(symbol: string): Promise<McBar[]> {
  const key = symbol.toUpperCase();
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.ts < CACHE_TTL_MS) return mem.bars;

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch { /* ignore */ }
  const cachePath = `${CACHE_DIR}/${key}.json`;
  if (existsSync(cachePath)) {
    try {
      const bars = JSON.parse(readFileSync(cachePath, "utf8")) as McBar[];
      if (Array.isArray(bars) && bars.length) {
        memCache.set(key, { bars, ts: Date.now() });
        return bars;
      }
    } catch { /* refetch */ }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const state = getSessionState();
      if (!state.authenticated) await initSession();
      const breeze = getBreezeClient();
      const stockCode = await resolveBreezeStockCode(key);
      if (!stockCode) return [];
      const to = new Date();
      to.setHours(15, 30, 0, 0);
      const from = new Date(to.getTime() - MC_CONFIG.lookbackDays * 24 * 3600 * 1000);
      from.setHours(9, 15, 0, 0);
      const r = await breeze.getHistoricalDatav2({
        interval: "5minute",
        fromDate: fmtBreeze(from),
        toDate: fmtBreeze(to),
        stockCode,
        exchangeCode: ["SENSEX", "BANKEX"].includes(key) ? "BSE" : "NSE",
        productType: "cash",
        expiryDate: "",
        right: "",
        strikePrice: "",
      });
      if (r?.Error || r?.Status === 401) {
        if (attempt === 3) return [];
        await sleep(400 * attempt);
        continue;
      }
      const rows: any[] = r?.Success || r?.data || r || [];
      if (!Array.isArray(rows) || !rows.length) return [];
      const bars: McBar[] = [];
      for (const c of rows) {
        const timeStr = String(c.time || c.datetime || c.timestamp || "");
        if (!timeStr) continue;
        const open = Number(c.open ?? c.o);
        const high = Number(c.high ?? c.h);
        const low = Number(c.low ?? c.l);
        const close = Number(c.close ?? c.c);
        if (!open && !high && !low && !close) continue;
        bars.push({
          date: timeStr.slice(0, 10),
          time: timeStr.length === 16 ? timeStr + ":00" : timeStr,
          open,
          high,
          low,
          close,
          volume: Number(c.volume ?? c.v ?? 0),
        });
      }
      bars.sort((a, b) => a.time.localeCompare(b.time));
      if (bars.length) {
        memCache.set(key, { bars, ts: Date.now() });
        try {
          writeFileSync(cachePath, JSON.stringify(bars));
        } catch { /* disk optional */ }
      }
      return bars;
    } catch {
      if (attempt === 3) return [];
      await sleep(300 * attempt);
    }
  }
  return [];
}

export interface McAnnotatable {
  symbol: string;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  entry: number;
  totalScore: number;
  mcPct?: number;
  mcPs?: number;
  mcGap?: number;
  mcPass?: boolean | null;
}

/**
 * Annotate the top directional candidates with MC gap fields.
 * Fail-open: no history / no time → mcPass stays null (never blocks).
 * Budget-capped so the 60s scanner route is not blown by Breeze.
 */
export async function annotateCandidatesWithMc(
  candidates: McAnnotatable[],
  opts: {
    maxCandidates?: number;
    budgetMs?: number;
    now?: Date;
    gapPass?: number;
  } = {},
): Promise<number> {
  const maxN = opts.maxCandidates ?? MC_CONFIG.maxCandidates;
  const budgetMs = opts.budgetMs ?? MC_CONFIG.budgetMs;
  const deadline = Date.now() + budgetMs;
  const gapPass = opts.gapPass ?? MC_CONFIG.gapPass;
  const now = opts.now ?? new Date();
  const decisionMin = clampToSession(istDecisionMinutes(now));
  const today = todayIst(now);

  const eligible = candidates
    .filter((c) => c.direction !== "NEUTRAL" && c.entry > 0)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, maxN);

  if (!eligible.length) return 0;

  let annotated = 0;
  const CONCURRENCY = 3;
  let idx = 0;

  async function work(): Promise<void> {
    while (idx < eligible.length) {
      if (Date.now() > deadline) return;
      const i = idx++;
      const c = eligible[i];
      try {
        const bars = await fetchPrior5mBars(c.symbol);
        if (Date.now() > deadline) return;
        const prior = priorDatesFrom(bars, today);
        if (prior.length < 5) {
          c.mcPass = null;
          continue;
        }
        const dir: McDir = c.direction === "BULLISH" ? "LONG" : "SHORT";
        const mc = monteCarloBracket(bars, prior, c.entry, dir, decisionMin);
        if (!mc.available) {
          c.mcPass = null;
          continue;
        }
        c.mcPct = Math.round(mc.pTarget * 1000) / 1000;
        c.mcPs = Math.round(mc.pStop * 1000) / 1000;
        c.mcGap = Math.round(mc.gap * 1000) / 1000;
        c.mcPass = mc.gap >= gapPass;
        annotated++;
      } catch {
        c.mcPass = null;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, () => work()),
  );
  return annotated;
}
