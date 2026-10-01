// ═════════════════════════════════════════════════════════════
// Evidence Fetcher — real historical OI/Greeks/news evidence per trade.
// OI/Greeks come from the market-history sidecar (:4002) chain_ticks for
// the snapshot nearest to (but not after) the trade's entry time.
// News comes ONLY from what was recorded in trade.marketContext at signal
// time — historical RSS cannot be replayed, so unrecorded news is
// "NOT AVAILABLE", never back-filled.
// ═════════════════════════════════════════════════════════════

import {
  TradeEvidence,
  OIEvidence,
  GreeksEvidence,
  NewsEvidence,
  emptyEvidence,
} from "@/lib/evidence-verifier";

// Import the sidecar client lazily so this module can be unit-tested with
// a stubbed fetcher (tests never touch the network).
let snapshotsProvider: ((symbol: string, date: string) => Promise<any[]>) | null = null;

export function setSnapshotsProvider(
  fn: (symbol: string, date: string) => Promise<any[]>
): void {
  snapshotsProvider = fn;
}

async function defaultSnapshotsProvider(
  symbol: string,
  date: string
): Promise<any[]> {
  const { getSnapshotsForSymbol } = await import("@/lib/market-history-client");
  return getSnapshotsForSymbol(symbol, date);
}

// ─── Historical snapshot selection ─────────────────────────────
// Pick the snapshot with the latest timestamp that is still <= entry time.
// A snapshot AFTER entry must not be used — evidence has to be what the
// signal could have seen.

export function pickSnapshotAtOrBefore(
  snapshots: any[],
  entryTimeIso: string
): any | null {
  const entryMs = new Date(entryTimeIso).getTime();
  if (!isFinite(entryMs)) return null;
  let best: any = null;
  let bestMs = -Infinity;
  for (const s of snapshots) {
    const ms = new Date(s.timestamp).getTime();
    if (isFinite(ms) && ms <= entryMs && ms > bestMs) {
      best = s;
      bestMs = ms;
    }
  }
  return best;
}

// ─── Build OI evidence from a snapshot ─────────────────────────

export function buildOiEvidence(snapshot: any): OIEvidence | null {
  const chain = snapshot?.optionChain;
  if (!Array.isArray(chain) || chain.length === 0) return null;

  const spot = Number(snapshot.spot) || 0;
  const legs = chain.filter(
    (l: any) => typeof l.strike === "number" && typeof l.oi === "number"
  );
  if (!legs.length) return null;

  const ceLegs = legs.filter((l: any) => String(l.type).toUpperCase() === "CE");
  const peLegs = legs.filter((l: any) => String(l.type).toUpperCase() === "PE");

  const totalCeOi = ceLegs.reduce((s: number, l: any) => s + Math.max(0, l.oi), 0);
  const totalPeOi = peLegs.reduce((s: number, l: any) => s + Math.max(0, l.oi), 0);
  const pcr = totalCeOi > 0 ? totalPeOi / totalCeOi : null;

  // Resistance = highest CE OI at/above spot; support = highest PE OI at/below spot
  let resistance: OIEvidence["oiResistance"] = null;
  for (const l of ceLegs) {
    if (spot && l.strike < spot) continue;
    if (!resistance || l.oi > resistance.ceOi)
      resistance = { strike: l.strike, ceOi: l.oi };
  }
  let support: OIEvidence["oiSupport"] = null;
  for (const l of peLegs) {
    if (spot && l.strike > spot) continue;
    if (!support || l.oi > support.peOi)
      support = { strike: l.strike, peOi: l.oi };
  }

  // OI change near spot (within 1%)
  let peChange = 0;
  let ceChange = 0;
  if (spot) {
    const near = legs.filter(
      (l: any) => Math.abs(l.strike - spot) / spot <= 0.01
    );
    for (const l of near) {
      const chg = Number(l.oiChg) || 0;
      if (String(l.type).toUpperCase() === "PE") peChange += chg;
      else ceChange += chg;
    }
  }

  // ATM = strike nearest spot, both sides present
  let atmOis: OIEvidence["atmOis"] = null;
  if (spot) {
    let bestDist = Infinity;
    for (const l of legs) {
      const d = Math.abs(l.strike - spot);
      if (d < bestDist) {
        bestDist = d;
        const ce = ceLegs.find((c: any) => c.strike === l.strike);
        const pe = peLegs.find((p: any) => p.strike === l.strike);
        atmOis = {
          strike: l.strike,
          ceOi: ce ? ce.oi : 0,
          peOi: pe ? pe.oi : 0,
        };
      }
    }
  }

  return {
    pcr,
    oiResistance: resistance,
    oiSupport: support,
    oiChangeNearSpot: spot ? { peChange, ceChange } : null,
    maxPain: typeof snapshot.maxPain === "number" ? snapshot.maxPain : null,
    atmOis,
  };
}

// ─── Build Greeks evidence from a snapshot ─────────────────────
// All math is real, computed from stored chain legs. Null when the input
// isn't there — never a placeholder number.

export function buildGreeksEvidence(
  snapshot: any,
  spotFallback?: number
): GreeksEvidence | null {
  const chain = snapshot?.optionChain;
  if (!Array.isArray(chain) || chain.length === 0) return null;

  const spot = Number(snapshot.spot) || Number(spotFallback) || 0;
  if (!spot) return null;

  const ceLegs = chain.filter((l: any) => String(l.type).toUpperCase() === "CE");
  const peLegs = chain.filter((l: any) => String(l.type).toUpperCase() === "PE");

  // ATM = nearest strike
  let atmStrike = spot;
  let bestDist = Infinity;
  for (const l of chain) {
    const d = Math.abs(Number(l.strike) - spot);
    if (isFinite(d) && d < bestDist) {
      bestDist = d;
      atmStrike = Number(l.strike);
    }
  }
  const atmCe = ceLegs.find((l: any) => l.strike === atmStrike);
  const atmPe = peLegs.find((l: any) => l.strike === atmStrike);

  // ATM IV = mean of available ATM leg IVs
  let atmIv: number | null = null;
  const ivs = [atmCe?.iv, atmPe?.iv].filter(
    (v: any) => typeof v === "number" && isFinite(v) && v > 0
  );
  if (ivs.length) atmIv = ivs.reduce((a: number, b: number) => a + b, 0) / ivs.length;
  else if (typeof snapshot.iv === "number" && snapshot.iv > 0) atmIv = snapshot.iv;

  // Put-call skew = ATM PE IV − ATM CE IV
  let skew: number | null = null;
  if (atmPe?.iv && atmCe?.iv) skew = Number(atmPe.iv) - Number(atmCe.iv);

  // Gamma flip: strike where CE−PE gamma·OI balance crosses zero scanning upward
  const gammaFlip = computeGammaFlip(chain, spot);

  // Expected move: spot × VIX/100 / sqrt(252) — 1-sigma daily points
  let expectedMove: number | null = null;
  const vix = Number(snapshot.indiaVix);
  if (isFinite(vix) && vix > 0 && spot) {
    expectedMove = (spot * (vix / 100)) / Math.sqrt(252);
  }

  // ATM theta/day as % of ATM premium (long option: negative number → keep sign).
  // 0 means greeks were never computed (NSE legacy legs) → null, never a fake 0%.
  let atmThetaPct: number | null = null;
  const atmLtp = atmCe?.ltp ?? atmPe?.ltp;
  const atmTheta = [atmCe?.greeks?.theta, atmPe?.greeks?.theta].find(
    (t) => typeof t === "number" && t !== 0 && isFinite(t)
  );
  if (typeof atmTheta === "number" && typeof atmLtp === "number" && atmLtp > 0) {
    atmThetaPct = (atmTheta / atmLtp) * 100;
  }

  // ATM delta per side — 0 (or non-finite) means uncomputed → null
  const toDelta = (v: any): number | null =>
    typeof v === "number" && isFinite(v) && v !== 0 ? v : null;
  const atmDeltaCe = toDelta(atmCe?.greeks?.delta);
  const atmDeltaPe = toDelta(atmPe?.greeks?.delta);

  // Regime from recorded features if present
  let regime: string | null = null;
  const feats = snapshot.features;
  if (feats && typeof feats === "object") {
    regime =
      feats.regime ?? feats.marketRegime ?? feats.trendRegime ?? feats.trend ?? null;
    if (typeof regime !== "string") regime = null;
  }

  if (
    atmIv === null &&
    skew === null &&
    gammaFlip === null &&
    expectedMove === null &&
    atmThetaPct === null &&
    atmDeltaCe === null &&
    atmDeltaPe === null
  ) {
    return null; // chain present but no usable greek values → treat as unavailable
  }

  return {
    atmIv,
    skew,
    gammaFlip,
    regime,
    expectedMove,
    atmThetaPct,
    atmDeltaCe,
    atmDeltaPe,
  };
}

function computeGammaFlip(chain: any[], spot: number): number | null {
  const strikes = Array.from(
    new Set(
      chain
        .map((l) => Number(l.strike))
        .filter((s) => isFinite(s))
    )
  ).sort((a, b) => a - b);
  if (strikes.length < 2) return null;

  let prevSign: number | null = null;
  for (const k of strikes) {
    const ce = chain.find(
      (l) => l.strike === k && String(l.type).toUpperCase() === "CE"
    );
    const pe = chain.find(
      (l) => l.strike === k && String(l.type).toUpperCase() === "PE"
    );
    const ceG = (Number(ce?.greeks?.gamma) || 0) * (Number(ce?.oi) || 0);
    const peG = (Number(pe?.greeks?.gamma) || 0) * (Number(pe?.oi) || 0);
    const bal = ceG - peG;
    if (bal === 0) continue;
    const sign = bal > 0 ? 1 : -1;
    if (prevSign !== null && sign !== prevSign) return k;
    prevSign = sign;
  }
  return null;
}

// ─── News evidence from recorded marketContext ─────────────────
// Recorded shape is flexible: {newsScore, newsHeadlines} or {news:{score,headlines}}.

export function buildNewsEvidence(
  marketContext: Record<string, unknown> | null | undefined
): NewsEvidence | null {
  if (!marketContext) return null;
  const ctx = marketContext as any;

  let score: number | null = null;
  let headlines: NewsEvidence["headlines"] = [];

  if (ctx.news && typeof ctx.news === "object") {
    const n = ctx.news;
    if (typeof n.score === "number") score = n.score;
    if (Array.isArray(n.headlines)) headlines = n.headlines;
  }
  if (Array.isArray(ctx.newsHeadlines)) {
    headlines = ctx.newsHeadlines;
  }
  if (score === null && typeof ctx.newsScore === "number") score = ctx.newsScore;
  if (Array.isArray(ctx.headlines)) headlines = ctx.headlines;

  headlines = headlines
    .filter((h: any) => h && typeof h.title === "string" && h.title.trim())
    .map((h: any) => ({
      title: String(h.title),
      source: h.source ?? null,
      url: h.url ?? null,
      publishedAt: h.publishedAt ?? h.published_at ?? null,
    }));

  if (score === null && headlines.length === 0) return null;
  return { score, headlines, origin: "recorded" };
}

// ─── Main: fetch evidence for one trade ────────────────────────

export interface EvidenceFetchInput {
  symbol: string;
  entryTime: string;
  spotFallback: number;
  marketContext?: Record<string, unknown> | null;
}

export async function fetchTradeEvidence(
  input: EvidenceFetchInput
): Promise<TradeEvidence> {
  const { symbol, entryTime, spotFallback, marketContext } = input;
  const date = String(entryTime).slice(0, 10);

  let snapshot: any = null;
  let providerError: string | null = null;
  let snapshotMissing = true;
  try {
    const provider = snapshotsProvider || defaultSnapshotsProvider;
    const snaps = await provider(symbol, date);
    snapshot = pickSnapshotAtOrBefore(snaps, entryTime);
    snapshotMissing = !snapshot;
  } catch (e: any) {
    // Recorder/sidecar lookup itself failed — do NOT conflate with a real data gap.
    providerError = String(e?.message || e);
    snapshotMissing = true;
  }

  const oi = snapshot ? buildOiEvidence(snapshot) : null;
  const greeks = snapshot ? buildGreeksEvidence(snapshot, spotFallback) : null;
  const news = buildNewsEvidence(marketContext);

  const hasAny = !!oi || !!greeks || !!news;
  if (!hasAny) {
    const why = providerError
      ? `recorder lookup failed: ${providerError}`
      : snapshotMissing
        ? "historical OI/Greeks data not accessible for this date"
        : "no usable OI/Greeks values in snapshot and no recorded news";
    return emptyEvidence(why);
  }

  return {
    available: true,
    unavailableReason: null,
    oi,
    greeks,
    news,
    biasScore:
      typeof (marketContext as any)?.biasScore === "number"
        ? (marketContext as any).biasScore
        : null,
    groupsAgreeing:
      typeof (marketContext as any)?.groupsAgreeing === "number"
        ? (marketContext as any).groupsAgreeing
        : null,
    groupsTotal:
      typeof (marketContext as any)?.groupsTotal === "number"
        ? (marketContext as any).groupsTotal
        : null,
    confidence:
      typeof (marketContext as any)?.confidence === "string"
        ? (marketContext as any).confidence
        : null,
  };
}
