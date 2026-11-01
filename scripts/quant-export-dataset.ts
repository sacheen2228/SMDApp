#!/usr/bin/env bun
// quant-export-dataset.ts — freeze a REAL historical dataset for the
// UNIVERSAL_QUANT_V1 backtester.
//
// SOURCE: ICICI Breeze getHistoricalDatav2 (read-only historical data —
// never an order). Two series per run:
//   • underlying  → stockCode NIFTY, exchangeCode NSE, productType cash
//   • options     → stockCode NIFTY, exchangeCode NFO, productType options,
//                   right call|put, strikePrice, expiryDate
// Both are RECORDED exchange prices (open/high/low/close/volume/OI).
//
// OUTPUT: data/quant-datasets/<datasetId>.json
//   { datasetId, createdAt, source, contractMaster, underlying, options, hash }
// The hash is SHA-256 over the canonical dataset body (everything except the
// hash field) — it identifies the EXACT data a backtest run consumed.
//
// Usage:
//   bun scripts/quant-export-dataset.ts --symbol NIFTY --expiry 2026-10-27 \
//     --from 2026-10-21 --to 2026-10-23 --strikes 22500,23000,23500,24000,24500
//
// The script NEVER invents a bar: a provider error or an empty result is
// recorded as an error and the export fails loudly.

import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { initSession, getBreezeClient } from "../src/lib/icici-breeze/auth";
import { getLotSizeStrict, getTickSize } from "../src/lib/symbol-config";

interface ArgMap { [k: string]: string }

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

interface Bar {
  timestamp: string; // IST "YYYY-MM-DD HH:MM:SS"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number | null;
}

function toBars(rows: any[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of rows) {
    const dt = String(r.datetime ?? r.time ?? "");
    if (!dt) continue;
    const o = Number(r.open ?? 0);
    const h = Number(r.high ?? 0);
    const l = Number(r.low ?? 0);
    const c = Number(r.close ?? 0);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || c <= 0) continue;
    bars.push({
      // Breeze returns IST wall-clock strings; keep them as-is and expose a
      // parseable ISO (the IST offset is fixed at +05:30).
      timestamp: dt.length <= 19 ? `${dt.replace(" ", "T")}+05:30` : dt,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: Number(r.volume ?? 0) || 0,
      oi: r.open_interest != null ? Number(r.open_interest) : null,
    });
  }
  bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return bars;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const symbol = (args.symbol ?? "NIFTY").toUpperCase();
  const expiry = args.expiry ?? "";
  const from = args.from ?? "";
  const to = args.to ?? "";
  const interval = args.interval ?? "5minute";
  const strikes = (args.strikes ?? "22500,23000,23500,24000,24500")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((s) => Number.isFinite(s) && s > 0);

  if (!expiry || !from || !to) {
    console.error("usage: --expiry YYYY-MM-DD --from YYYY-MM-DD --to YYYY-MM-DD [--symbol NIFTY] [--strikes a,b,c]");
    process.exit(2);
  }

  const lotSize = getLotSizeStrict(symbol);
  if (lotSize == null) {
    console.error(`lot size for ${symbol} is UNKNOWN in the contract master — refusing to export (fail closed)`);
    process.exit(2);
  }
  const tickSize = getTickSize(symbol);

  await initSession();
  const breeze = getBreezeClient();

  const fromDt = `${from} 09:15:00`;
  const toDt = `${to} 15:30:00`;

  const underlyingRes = await breeze.getHistoricalDatav2({
    interval,
    fromDate: fromDt,
    toDate: toDt,
    stockCode: symbol,
    exchangeCode: "NSE",
    productType: "cash",
  });
  const underlyingRows = underlyingRes?.Success ?? [];
  if (!underlyingRows.length) {
    console.error(`underlying fetch returned no rows (${underlyingRes?.Error ?? "unknown error"}) — nothing exported`);
    process.exit(1);
  }
  const underlying = toBars(underlyingRows);

  const options: Array<{
    tradingsymbol: string;
    strike: number;
    optionType: "CE" | "PE";
    expiry: string;
    lotSize: number;
    tickSize: number;
    bars: Bar[];
  }> = [];

  for (const strike of strikes) {
    for (const right of ["call", "put"]) {
      const optionType = right === "call" ? "CE" : "PE";
      const res = await breeze.getHistoricalDatav2({
        interval,
        fromDate: fromDt,
        toDate: toDt,
        stockCode: symbol,
        exchangeCode: "NFO",
        productType: "options",
        right,
        strikePrice: String(strike),
        expiryDate: expiry,
      });
      const rows = res?.Success ?? [];
      if (!rows.length) {
        console.error(`option fetch empty: ${symbol} ${strike} ${optionType} ${expiry} — ${res?.Error ?? "no rows"}`);
        process.exit(1);
      }
      const bars = toBars(rows);
      const d = new Date(expiry + "T00:00:00Z");
      const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()];
      const dd = String(d.getUTCDate()).padStart(2, "0");
      const yy = String(d.getUTCFullYear()).slice(2);
      options.push({
        tradingsymbol: `${symbol}${dd}${mon}${yy}${strike}${optionType}`,
        strike,
        optionType,
        expiry,
        lotSize,
        tickSize,
        bars,
      });
      console.log(`captured ${symbol} ${strike} ${optionType} ${expiry}: ${bars.length} bars`);
    }
  }

  const body = {
    datasetId: `${symbol.toLowerCase()}-${interval}-${from}_${to}-${expiry}`,
    createdAt: new Date().toISOString(),
    source: {
      provider: "ICICI Breeze",
      endpoint: "getHistoricalDatav2",
      readOnly: true,
      interval,
      underlyingParams: { stockCode: symbol, exchangeCode: "NSE", productType: "cash", fromDate: fromDt, toDate: toDt },
      optionParams: { stockCode: symbol, exchangeCode: "NFO", productType: "options", expiryDate: expiry },
    },
    contractMaster: {
      symbol,
      lotSize,
      tickSize,
      lotSizeSource: "src/lib/symbol-config.ts (fail-closed master)",
      expiry,
      expirySource: "recorded contract expiry supplied by the caller (never guessed)",
    },
    underlying: { symbol, bars: underlying },
    options,
  };

  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const out = { ...body, hash };
  const dir = join(process.cwd(), "data", "quant-datasets");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${out.datasetId}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nunderlying bars: ${underlying.length}`);
  console.log(`option contracts: ${options.length}`);
  console.log(`dataset hash: ${hash}`);
  console.log(`written: ${file}`);
}

main().catch((e) => {
  console.error("dataset export failed:", e?.message ?? e);
  process.exit(1);
});
