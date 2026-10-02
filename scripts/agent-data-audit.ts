/// <reference types="bun-types" />
// Agent data audit — runs every Hermes/SDM tool with sensible defaults against
// the live local API and reports which tools actually return data vs empty vs
// error. Also audits collectHermesContext (the supervisor's data builder) for
// null/missing slices, and runs the hermes_pro_analysis pipeline.
//
// Usage: bun scripts/agent-data-audit.ts [symbol]   (default NIFTY)

const ROOT = "/home/sachin/Desktop/SMDApp";
const API = "http://localhost:3000";
const SYMBOL = process.argv[2] || "NIFTY";

const { AGENT_TOOLS, executeTool } = await import(`${ROOT}/src/lib/agent-brain.ts`);
const { collectHermesContext } = await import(`${ROOT}/src/lib/hermes/context.ts`);

// Side-effect tools — never invoke in an audit sweep.
const SKIP = new Set([
  "send_telegram_signal", // pushes to phone
  "morning_scan", // sends telegram digest
  "record_trade_memory", // writes memory DB
  "set_breeze_session", // re-applies session token
]);

const ARGS: Record<string, any> = {
  calculate_position_size: { entry: 150, sl: 100, lotSize: 75 },
  strike_selector: { direction: "call", target: 22550, stop: 22350, days: 5, lotSize: 75, capital: 200000 },
  answer_trading_question: { question: "what is PCR and how do I read it?" },
  get_cas_analysis: { symbol: SYMBOL },
  get_institutional_positioning: { symbol: SYMBOL },
  get_options_edge: { symbol: SYMBOL, strike: 22400, side: "CE" },
  get_expiry_liquidity: { symbol: SYMBOL },
  get_market_regime: { symbol: SYMBOL },
  get_atm_straddle: { symbol: SYMBOL },
  get_trade_post_mortem: { symbol: SYMBOL, strategy: "audit", entryPrice: 100, exitPrice: 110, pnl: 750 },
  search_memory: { query: SYMBOL },
  trace_data_flow: { feature: "option_chain" },
  test_api_endpoint: { url: API + "/api/fii-dii" },
  hermes_pro_analysis: { symbol: SYMBOL, mode: "TRADE" },
  get_mcx_data: { symbol: "CRUDEOIL" },
};

const ctx = {
  symbol: SYMBOL,
  spotPrice: 22421.95,
  analysis: {},
  summary: { indiaVIX: 14.4 },
  apiBase: API,
};

type Status = "DATA" | "EMPTY" | "ARGS" | "ERR" | "SKIP";

function classify(out: string): { status: Status; detail: string } {
  const s = (out || "").trim();
  const head = s.slice(0, 160).replace(/\s+/g, " ");
  if (!s) return { status: "ERR", detail: "empty output" };
  if (/^unknown tool/i.test(s)) return { status: "ERR", detail: "not implemented" };
  if (/Strike selector needs:|input error: the following arguments are required/i.test(s)) return { status: "ARGS", detail: head };
  // "Errors: 16" style stat lines are DATA, not failures — strip counts first
  const errish = s.slice(0, 120).replace(/errors?\s*:\s*\d+/ig, "");
  if (/(failed|error|not found|cannot|exception)/i.test(errish) && s.length < 400) return { status: "ERR", detail: head };
  if (/^(no |not available|unavailable|nothing |0 trades|no positions|no holdings)/i.test(s) && s.length < 500) return { status: "EMPTY", detail: head };
  if (/No .* available|no data|empty|not running|zero /i.test(s) && s.length < 300) return { status: "EMPTY", detail: head };
  return { status: "DATA", detail: `${s.length} chars | ${head}` };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms / 1000}s`)), ms)),
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// auth.config.ts rate-limits reads at 60/min/IP (scanner 5/min, news 10/min).
// Audit paces to 1 request-stream at a time with 1.5s gaps to stay under it.
const PACE_MS = 1500;

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Section A: every agent tool ──────────────────────────────────────────
console.log(`\n═══ A. AGENT TOOLS DATA AUDIT (${AGENT_TOOLS.length} tools, symbol=${SYMBOL}) ═══`);
const names: string[] = AGENT_TOOLS.map((t: any) => t.function.name);

const rows = await pool(names, 1, async (name: string) => {
  if (SKIP.has(name)) return { name, status: "SKIP" as Status, detail: "side-effect tool — not invoked", ms: 0 };
  await sleep(PACE_MS);
  const t0 = Date.now();
  try {
    const out = await withTimeout(
      executeTool(name, ARGS[name] || {}, ctx),
      name === "scan_all_instruments" || name === "hermes_pro_analysis" ? 120_000 : 45_000
    );
    const { status, detail } = classify(String(out));
    return { name, status, detail, ms: Date.now() - t0 };
  } catch (e: any) {
    return { name, status: "ERR" as Status, detail: String(e?.message || e).slice(0, 140), ms: Date.now() - t0 };
  }
});

const icon: Record<Status, string> = { DATA: "✅", EMPTY: "⚪", ARGS: "🧩", ERR: "❌", SKIP: "⏭️" };
for (const r of rows) console.log(`${icon[r.status]} ${r.name.padEnd(30)} ${String(r.ms + "ms").padStart(7)}  ${r.detail}`);
const counts = rows.reduce((a: any, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
console.log(`── totals: ${JSON.stringify(counts)} ──`);

// ── Section B: Hermes supervisor context coverage ────────────────────────
console.log(`\n═══ B. HERMES SUPERVISOR CONTEXT (collectHermesContext) ═══`);

function brief(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") {
    if ("value" in v && "source" in v) return `FreshData(${brief(v.value)}, src=${v.source}, fresh=${(v as any).fresh ?? v.isFresh ?? "?"})`;
    const k = Object.keys(v);
    if (k.length === 0) return "empty object";
    return `object[${k.slice(0, 5).join(",")}${k.length > 5 ? ",…" : ""}]`;
  }
  if (typeof v === "string") return v.length > 60 ? `str(${v.length})` : JSON.stringify(v);
  return String(v);
}

for (const mode of ["RESEARCH", "TRADE"] as const) {
  await sleep(PACE_MS);
  const t0 = Date.now();
  const c: any = await withTimeout(collectHermesContext(SYMBOL, mode, API), 60_000);
  console.log(`\n── mode=${mode} (${Date.now() - t0}ms) ──`);
  const topKeys = Object.keys(c || {});
  for (const k of topKeys) {
    const v = c[k];
    if (v === null || v === undefined) { console.log(`  ❌ ${k}: NULL`); continue; }
    if (typeof v === "function") continue;
    // FreshData slices: mark NULL values inside
    if (v && typeof v === "object" && "value" in v && (v.value === null || v.value === undefined)) {
      console.log(`  ❌ ${k}: FreshData.value NULL (src=${(v as any).source})`);
      continue;
    }
    console.log(`  ✅ ${k}: ${brief(v)}`);
  }
  // Key derived numbers when present
  try {
    const spot = c.spot?.value?.price ?? c.spotPrice;
    const regime = c.regime?.value?.regime ?? c.regime?.value?.label ?? c.regime;
    const vix = c.vix?.value;
    console.log(`  → spot=${spot} | regime=${typeof regime === "object" ? JSON.stringify(regime).slice(0, 90) : regime} | vix=${JSON.stringify(vix) ?? "n/a"}`);
  } catch { /* shape variance — informational only */ }
}

// ── Section C: hermes_pro_analysis pipeline ──────────────────────────────
console.log(`\n═══ C. HERMES PRO PIPELINE ═══`);
await sleep(PACE_MS);
const t0 = Date.now();
try {
  const out = await withTimeout(executeTool("hermes_pro_analysis", { symbol: SYMBOL, mode: "TRADE" }, ctx), 120_000);
  console.log(String(out).slice(0, 1500));
  console.log(`… [${String(out).length} chars, ${Date.now() - t0}ms]`);
} catch (e: any) {
  console.log(`PIPELINE ERROR: ${e?.message || e}`);
}
console.log("\n═══ AUDIT DONE ═══");

export {};
