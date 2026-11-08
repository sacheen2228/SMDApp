// scripts/repair-oi-units.js — ONE-OFF data repair (kept for reproducibility).
//
// WHAT: recorded chain history mixes two units. The recorder flaps between
// providers (Breeze first, NSE/BSE fallback), and:
//   Breeze getOptionChainQuotes → UNDERLYING UNITS (contracts × lot)
//   NSE / BSE live APIs          → CONTRACTS (canonical)
// So 241 of 529 recorded snapshots (NIFTY 126, SENSEX 115) carry OI/volume
// ~65×/~20× too large, which corrupted the OI panel's Full Day chart
// (all-negative crores instead of mixed-sign lakhs).
//
// FIX: for every Breeze-sourced snapshot, ÷ lot in chain_ticks (oi, oi_chg,
// volume) AND market_snapshots (payload.optionChain legs, payload.volume,
// payload.features.totalVolume, the volume column). Ratios (pcr_oi, pcr_vol,
// maxPain) are unit-invariant and untouched.
//
// CLASSIFICATION (measured, not guessed) — a snapshot is Breeze iff:
//   legs ≤ 140 (Breeze serves a ~60-strike grid; NSE/BSE serve 135-193),
//   every leg has iv == null (Breeze returned no IV that session),
//   every non-zero oi/oi_chg/volume is an EXACT multiple of the lot
//   (0 of ~15k NSE/BSE rows satisfy all three — see tests/oi-units.test.ts).
// Idempotent: after repair the divisibility test fails, so a rerun is a no-op.
//
// LOTS mirror src/lib/symbol-config.ts (single source of truth — update both
// if the exchange revises a lot).
//
// Usage:
//   node scripts/repair-oi-units.js           # dry run — prints what would change
//   node scripts/repair-oi-units.js --apply   # writes the repair

const path = require("path");
const Database = require("better-sqlite3");

const LOT = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  MIDCPNIFTY: 120,
  SENSEX: 20,
  BANKEX: 30,
};

const DB_PATH = path.join(__dirname, "..", "db", "market_history.db");
const APPLY = process.argv.includes("--apply");

function isBreezeSnapshot(legs, lot) {
  if (!Array.isArray(legs) || legs.length === 0 || legs.length > 140) return false;
  const strikes = new Set();
  let oiPos = 0;
  for (const l of legs) {
    strikes.add(l.strike);
    if (!(l.iv == null || l.iv === 0)) return false; // NSE/BSE legs carry IV
    const oi = l.oi || 0;
    if (oi > 0) {
      oiPos++;
      const chg = Math.abs(l.oiChg || 0);
      const vol = Math.abs(l.volume || 0);
      if (oi % lot !== 0 || chg % lot !== 0 || vol % lot !== 0) return false;
    }
  }
  if (strikes.size > 75) return false;
  return true; // small grid + all-IV-null + exact multiples → Breeze (units)
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const snaps = db.prepare("SELECT id, symbol, payload, volume FROM market_snapshots").all();
const stats = { scanned: 0, breeze: 0, skippedNoLot: 0, ticksUpdated: 0, payloadsUpdated: 0, bySymbol: {} };
const targets = [];

for (const s of snaps) {
  stats.scanned++;
  let j;
  try {
    j = JSON.parse(s.payload || "{}");
  } catch {
    continue;
  }
  const legs = j.optionChain || [];
  if (!legs.length) continue;
  const lot = LOT[s.symbol];
  if (!lot) {
    stats.skippedNoLot++;
    console.warn(`  ! no lot for ${s.symbol} (${s.id}) — left untouched`);
    continue;
  }
  if (!isBreezeSnapshot(legs, lot)) continue;
  stats.breeze++;
  stats.bySymbol[s.symbol] = (stats.bySymbol[s.symbol] || 0) + 1;
  targets.push({ id: s.id, symbol: s.symbol, lot, legs, payload: j, colVolume: s.volume });
}

console.log(`scanned ${stats.scanned} snapshots → ${stats.breeze} Breeze-sourced (units)`);
console.log("by symbol:", JSON.stringify(stats.bySymbol));
if (stats.skippedNoLot) console.log(`skipped (unknown lot): ${stats.skippedNoLot}`);

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write.");
  db.close();
  process.exit(0);
}

const updTicks = db.prepare(
  "UPDATE chain_ticks SET oi = ROUND(oi / ?), oi_chg = ROUND(oi_chg / ?), volume = ROUND(volume / ?) WHERE snapshot_id = ?"
);
const updSnap = db.prepare("UPDATE market_snapshots SET payload = ?, volume = ROUND(volume / ?) WHERE id = ?");

const run = db.transaction(() => {
  for (const t of targets) {
    // 1. per-strike ticks
    stats.ticksUpdated += updTicks.run(t.lot, t.lot, t.lot, t.id).changes;
    // 2. payload legs + totals
    for (const l of t.legs) {
      if (l.oi) l.oi = Math.round(l.oi / t.lot);
      if (l.oiChg) l.oiChg = Math.round(l.oiChg / t.lot);
      if (l.volume) l.volume = Math.round(l.volume / t.lot);
    }
    if (t.payload.volume) t.payload.volume = Math.round(t.payload.volume / t.lot);
    if (t.payload.features && t.payload.features.totalVolume) {
      t.payload.features.totalVolume = Math.round(t.payload.features.totalVolume / t.lot);
    }
    stats.payloadsUpdated += updSnap.run(JSON.stringify(t.payload), t.lot, t.id).changes;
  }
});
run();

// Verify: no snapshot still classifies as Breeze (idempotency proof).
const after = db.prepare("SELECT id, symbol, payload FROM market_snapshots").all();
let remaining = 0;
for (const s of after) {
  let j;
  try {
    j = JSON.parse(s.payload || "{}");
  } catch {
    continue;
  }
  const lot = LOT[s.symbol];
  if (lot && isBreezeSnapshot(j.optionChain || [], lot)) remaining++;
}

console.log(`\napplied: chain_ticks rows updated = ${stats.ticksUpdated}, snapshots updated = ${stats.payloadsUpdated}`);
console.log(`post-repair Breeze-classified snapshots remaining: ${remaining} (expect 0)`);
db.close();
if (remaining !== 0) {
  console.error("VERIFY FAILED — some snapshots still classify as Breeze");
  process.exit(1);
}
