#!/usr/bin/env bun
// ─── Data Pull for Monday 21 Jul 2026 — NIFTY + SENSEX only ──────

import { writeFileSync } from "fs";

const BASE = "http://localhost:3000";
const T = 20000;

async function j(url: string) {
  return (await fetch(url, { signal: AbortSignal.timeout(T) })).json();
}

function cr(v: number) {
  return `${v >= 0 ? "+" : ""}₹${v.toFixed(0)} Cr`;
}

async function pullChain(symbol: string) {
  const d = await j(`${BASE}/api/option-chain?symbol=${symbol}`);
  const c = d.data, s = c.summary, strikes = c.data || [];

  let ceOI = 0, peOI = 0, ceVol = 0, peVol = 0, ceChg = 0, peChg = 0;
  const ceWalls: any[] = [], peWalls: any[] = [];

  for (const x of strikes) {
    if (x.ce) {
      ceOI += x.ce.oi || 0; ceVol += x.ce.volume || 0; ceChg += x.ce.oiChg || 0;
      if ((x.ce.oi || 0) > 40000) ceWalls.push({ strike: x.strike, oi: x.ce.oi, chg: x.ce.oiChg, ltp: x.ce.ltp, vol: x.ce.volume });
    }
    if (x.pe) {
      peOI += x.pe.oi || 0; peVol += x.pe.volume || 0; peChg += x.pe.oiChg || 0;
      if ((x.pe.oi || 0) > 40000) peWalls.push({ strike: x.strike, oi: x.pe.oi, chg: x.pe.oiChg, ltp: x.pe.ltp, vol: x.pe.volume });
    }
  }
  ceWalls.sort((a, b) => b.oi - a.oi);
  peWalls.sort((a, b) => b.oi - a.oi);

  const atm = s.atmStrike;
  const near = strikes.filter((x: any) => Math.abs(x.strike - atm) <= s.spotPrice * 0.015);

  return {
    symbol, spot: s.spotPrice, atm, vix: s.indiaVIX, pcr: s.pcr,
    maxPain: s.maxPain, futures: s.futuresPrice, strikes: strikes.length,
    oi: { ceOI, peOI, ceVol, peVol, ceChg, peChg, pcrOI: +(peOI / (ceOI || 1)).toFixed(2), pcrVol: +(peVol / (ceVol || 1)).toFixed(2) },
    ceWalls: ceWalls.slice(0, 8).map(w => `${w.strike} OI:${(w.oi/1000).toFixed(0)}K Chg:${w.chg >= 0 ? '+' : ''}${(w.chg/1000).toFixed(0)}K LTP:₹${w.ltp} Vol:${(w.vol/1000).toFixed(0)}K`),
    peWalls: peWalls.slice(0, 8).map(w => `${w.strike} OI:${(w.oi/1000).toFixed(0)}K Chg:${w.chg >= 0 ? '+' : ''}${(w.chg/1000).toFixed(0)}K LTP:₹${w.ltp} Vol:${(w.vol/1000).toFixed(0)}K`),
    straddle: near.filter((x: any) => x.strike === atm).map((x: any) => ({
      strike: x.strike, ce: x.ce?.ltp, pe: x.pe?.ltp, total: (x.ce?.ltp || 0) + (x.pe?.ltp || 0),
      ceOI: x.ce?.oi, peOI: x.pe?.oi, ceVol: x.ce?.volume, peVol: x.pe?.volume,
    }))[0] || null,
    candles: c.candles?.length || 0,
  };
}

async function main() {
  console.log(`\n═══ NIFTY + SENSEX Data Pull — ${new Date().toISOString()} ═══\n`);

  const [nifty, sensex, fiiRaw] = await Promise.all([
    pullChain("NIFTY"),
    pullChain("SENSEX"),
    j(`${BASE}/api/fii-dii`),
  ]);

  const fii = {
    today: { date: fiiRaw.date, fiiNet: fiiRaw.fiiNet, diiNet: fiiRaw.diiNet, fiiBuy: fiiRaw.fiiBuy, fiiSell: fiiRaw.fiiSell, diiBuy: fiiRaw.diiBuy, diiSell: fiiRaw.diiSell },
    sum7d: { fii: (fiiRaw.history || []).slice(0, 7).reduce((s: number, h: any) => s + (h.fiiNet || 0), 0), dii: (fiiRaw.history || []).slice(0, 7).reduce((s: number, h: any) => s + (h.diiNet || 0), 0) },
    sum30d: { fii: (fiiRaw.history || []).reduce((s: number, h: any) => s + (h.fiiNet || 0), 0), dii: (fiiRaw.history || []).reduce((s: number, h: any) => s + (h.diiNet || 0), 0) },
    history: (fiiRaw.history || []).map((h: any) => ({ d: h.date?.slice(0, 11), fii: h.fiiNet, dii: h.diiNet })),
  };

  // Acceleration engine
  let accel: any = null;
  try {
    const raw = await j(`${BASE}/api/greek-flow`);
    const r = raw.result || raw;
    accel = {
      regime: r.regime, expectedMove: r.expectedMove,
      calls: (r.topCalls || []).slice(0, 8).map((t: any) => ({
        s: t.strike, ltp: t.ltp, tp1: t.tp1, tp2: t.tp2, tp3: t.tp3,
        sl: t.sl, rr: t.rr, conf: t.probability, vel: t.expectedPremiumVelocity,
        accel: t.acceleration, speed: t.speed, sig: t.signal,
        oi: t.oi, vol: t.volume, delta: t.delta, gamma: t.gamma,
      })),
      puts: (r.topPuts || []).slice(0, 8).map((t: any) => ({
        s: t.strike, ltp: t.ltp, tp1: t.tp1, tp2: t.tp2, tp3: t.tp3,
        sl: t.sl, rr: t.rr, conf: t.probability, vel: t.expectedPremiumVelocity,
        accel: t.acceleration, speed: t.speed, sig: t.signal,
        oi: t.oi, vol: t.volume, delta: t.delta, gamma: t.gamma,
      })),
    };
  } catch {}

  // Save
  const report = { ts: new Date().toISOString(), for: "21-Jul-2026 Mon", nifty, sensex, fii, accel };
  const path = "/home/sachin/Desktop/SMDApp/data/nifty-sensex-jul20.json";
  writeFileSync(path, JSON.stringify(report, null, 2));

  // ─── Print ────────────────────────────────────────────────────────
  console.log("═══ SPOT & GREEKS ═══\n");
  console.log(`NIFTY   : ${nifty.spot} | ATM ${nifty.atm} | VIX ${nifty.vix} | PCR ${nifty.pcr} | MaxPain ${nifty.maxPain} | Futures ${nifty.futures} | ${nifty.strikes} strikes`);
  console.log(`SENSEX  : ${sensex.spot} | ATM ${sensex.atm} | PCR ${sensex.pcr} | MaxPain ${sensex.maxPain} | ${sensex.strikes} strikes`);
  console.log();

  console.log("═══ FII/DII ═══\n");
  console.log(`Today : FII ${cr(fii.today.fiiNet)} | DII ${cr(fii.today.diiNet)}`);
  console.log(`7-day : FII ${cr(fii.sum7d.fii)} | DII ${cr(fii.sum7d.dii)}`);
  console.log(`30-day: FII ${cr(fii.sum30d.fii)} | DII ${cr(fii.sum30d.dii)}`);
  console.log();

  console.log("═══ NIFTY OI ═══\n");
  console.log(`CE OI: ${(nifty.oi.ceOI/100000).toFixed(1)}L (+${(nifty.oi.ceChg/100000).toFixed(2)}L) | PE OI: ${(nifty.oi.peOI/100000).toFixed(1)}L (${(nifty.oi.peChg/100000).toFixed(2)}L) | PCR: ${nifty.oi.pcrOI}`);
  console.log(`CE Vol: ${(nifty.oi.ceVol/100000).toFixed(1)}L | PE Vol: ${(nifty.oi.peVol/100000).toFixed(1)}L | Vol PCR: ${nifty.oi.pcrVol}`);
  console.log(`Bias: ${nifty.oi.ceChg > nifty.oi.peChg ? "BEARISH (Call writers dominating)" : "BULLISH (Put writers dominating)"}`);
  console.log();
  console.log("Call Walls (resistance):");
  for (const w of nifty.ceWalls) console.log(`  ${w}`);
  console.log("Put Walls (support):");
  for (const w of nifty.peWalls) console.log(`  ${w}`);
  console.log();

  if (nifty.straddle) {
    const s = nifty.straddle;
    console.log(`ATM Straddle (${s.strike}): CE ₹${s.ce} + PE ₹${s.pe} = ₹${s.total}`);
    console.log(`  CE OI: ${(s.ceOI/1000).toFixed(0)}K Vol: ${(s.ceVol/1000).toFixed(0)}K | PE OI: ${(s.peOI/1000).toFixed(0)}K Vol: ${(s.peVol/1000).toFixed(0)}K`);
    console.log();
  }

  console.log("═══ SENSEX OI ═══\n");
  console.log(`CE OI: ${(sensex.oi.ceOI/100000).toFixed(1)}L (+${(sensex.oi.ceChg/100000).toFixed(2)}L) | PE OI: ${(sensex.oi.peOI/100000).toFixed(1)}L (${(sensex.oi.peChg/100000).toFixed(2)}L) | PCR: ${sensex.oi.pcrOI}`);
  console.log("Call Walls:");
  for (const w of sensex.ceWalls) console.log(`  ${w}`);
  console.log("Put Walls:");
  for (const w of sensex.peWalls) console.log(`  ${w}`);
  console.log();

  if (accel) {
    console.log("═══ NIFTY ACCELERATION ENGINE ═══\n");
    console.log(`Regime: ${accel.regime} | Expected Move: ${accel.expectedMove}pt`);
    console.log();
    console.log("Fastest Calls:");
    for (const c of accel.calls) console.log(`  ${c.s}: ₹${c.ltp} → TP1 ₹${c.tp1} TP2 ₹${c.tp2} | ${c.conf}% | Vel ${c.vel?.toFixed(2)}/m | Accel ${c.accel} | ${c.speed} | ${c.sig}`);
    console.log("Fastest Puts:");
    for (const p of accel.puts) console.log(`  ${p.s}: ₹${p.ltp} → TP1 ₹${p.tp1} TP2 ₹${p.tp2} | ${p.conf}% | Vel ${p.vel?.toFixed(2)}/m | Accel ${p.accel} | ${p.speed} | ${p.sig}`);
    console.log();
  }

  // FII daily table
  console.log("═══ FII/DII 30-DAY HISTORY ═══\n");
  console.log("  Date        FII Net     DII Net");
  for (const h of fii.history) {
    console.log(`  ${h.d.padEnd(12)} ${cr(h.fii).padStart(12)} ${cr(h.dii).padStart(12)}`);
  }

  console.log(`\n═══ Saved: ${path} ═══`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
