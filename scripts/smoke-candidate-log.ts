// End-to-end smoke: a real sendTradeAlert call must write a candidate_log row
// (sent or blocked), and the resolver must attempt to resolve it.
import { sendTradeAlert } from "../src/lib/telegram";
import { PrismaClient } from "@prisma/client";
import { resolvePendingCandidates } from "../src/lib/candidate-resolver";

const p = new PrismaClient();
const before = await p.candidateLog.count();
await p.$disconnect();

await sendTradeAlert({
  symbol: "NIFTY", action: "BUY CE", strike: 22600, type: "CE",
  confidence: 78, entry: 120, stopLoss: 100, target1: 170, target2: 200,
  source: "smoke-test", instrument: "CALL",
  spot: 22600, expiry: "2026-07-30",
});

const p2 = new PrismaClient();
const after = await p2.candidateLog.count();
const row = await p2.candidateLog.findFirst({ where: { source: "smoke-test" }, orderBy: { ts: "desc" } });
await p2.$disconnect();

console.log(`candidate_log rows ${before} → ${after}`);
console.log("row:", row ? JSON.stringify({
  source: row.source, symbol: row.symbol, gateVerdict: row.gateVerdict, tier: row.tier,
  rr: row.rr, underlyingSpot: row.underlyingSpot, entry: row.entryPremium, stop: row.stopPremium,
  sent: row.sent, wouldBlock: row.wouldBlock, warnings: row.warnings, fails: row.fails, configHash: row.configHash,
}, null, 2) : "NO ROW — logging is broken");

const res = await resolvePendingCandidates({ limit: 5, tf: "5m" });
console.log("resolver:", JSON.stringify(res.slice(0, 3)));
