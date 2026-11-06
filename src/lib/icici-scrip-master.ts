// ICICI scrip-code resolver.
//
// Breeze's own endpoints want ICICI's scrip codes, not NSE symbols:
//   RELIANCE → RELIND   SBIN → STABAN   NIFTYBEES → NIFBEE   ITC → ITC
// (plain "RELIANCE" returns 0 rows from getHistoricalDatav2 — verified
// live 2026-11-06). The mapping ships in SecurityMaster.zip's
// NSEScripMaster.txt: 61 columns, ICICI code at index 1, exchange symbol
// at index 60 (same positions the SDK's own getNames() reads).
//
// The SDK's standalone ScripFile URL (traderweb.icicidirect.com) does not
// resolve from this network — the zip URL is the one that answers.
// Resolution order: Breeze index codes → cached master (memory, then
// data/icici-scrip-master.json, 24h) → fresh zip download → raw ticker
// (ITC-style equality codes still work; never throws into a data path).

import AdmZip from "adm-zip";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

/** Breeze index codes — identical to historical-data.ts getBreezeStockCode. */
export const INDEX_BREEZE_CODES: Record<string, string> = {
  NIFTY: "NIFTY",
  BANKNIFTY: "CNXBAN",
  FINNIFTY: "NIFFIN",
  MIDCPNIFTY: "NIFMID",
  SENSEX: "BSESEN",
  BANKEX: "BSESEN",
};

const SECURITY_MASTER_URL =
  "https://directlink.icicidirect.com/MotherAppMaster/SecurityMaster.zip";
const SCRIP_ENTRY = "NSEScripMaster.txt";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MASTER_FIELDS = 61; // index 1 = ShortName (ICICI), index 60 = Symbol

/** Quote-aware CSV line parser ("a,b" / "a, ""q"" b" stay single fields). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * NSEScripMaster.txt → Map<EXCHANGE_SYMBOL, ICICI_CODE>.
 * EQ wins over another series for the same symbol; short/invalid rows and
 * the header are skipped.
 */
export function parseNseScripMaster(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const seriesBySymbol = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (cols.length < MASTER_FIELDS) continue;
    const token = cols[0].trim();
    if (token === "Token" || !token) continue;
    const short = (cols[1] || "").trim();
    const series = (cols[2] || "").trim();
    const symbol = (cols[60] || "").trim();
    if (!short || !symbol) continue;

    const prev = seriesBySymbol.get(symbol);
    if (prev === "EQ") continue; // EQ row already won
    if (prev && series !== "EQ") continue; // first wins until EQ arrives
    map.set(symbol, short);
    seriesBySymbol.set(symbol, series);
  }
  return map;
}

/** Pure lookup: index codes → master hit → raw uppercase ticker. */
export function lookupScrip(
  map: Map<string, string> | null,
  symbol: string,
): string {
  const sym = String(symbol || "").toUpperCase().trim();
  const indexCode = INDEX_BREEZE_CODES[sym];
  if (indexCode) return indexCode;
  if (!map) return sym;
  return map.get(sym) ?? sym;
}

let memoryMap: Map<string, string> | null = null;
let memoryAt = 0;
let inflight: Promise<Map<string, string>> | null = null;

function cachePath(): string {
  return join(process.cwd(), "data", "icici-scrip-master.json");
}

async function loadScripMap(): Promise<Map<string, string>> {
  if (memoryMap && Date.now() - memoryAt < CACHE_TTL_MS) return memoryMap;
  if (inflight) return inflight;

  inflight = (async () => {
    const file = cachePath();
    try {
      const cached = JSON.parse(await readFile(file, "utf8"));
      if (cached?.at && Date.now() - cached.at < CACHE_TTL_MS && cached.map) {
        memoryMap = new Map<string, string>(Object.entries(cached.map));
        memoryAt = Date.now();
        return memoryMap;
      }
    } catch {
      // no/stale/corrupt cache → fresh download below
    }

    const res = await fetch(SECURITY_MASTER_URL, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`SecurityMaster.zip HTTP ${res.status}`);
    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const entry = zip.getEntry(SCRIP_ENTRY);
    if (!entry) throw new Error(`${SCRIP_ENTRY} missing from SecurityMaster.zip`);
    const map = parseNseScripMaster(entry.getData().toString("utf8"));
    if (!map.size) throw new Error("scrip master parsed empty");

    memoryMap = map;
    memoryAt = Date.now();
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({ at: memoryAt, map: Object.fromEntries(map) }),
      );
    } catch {
      // cache write is best-effort — memory cache still holds the map
    }
    return map;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Symbol → Breeze stock_code for cash/daily endpoints.
 * Network only on a cold cache; index codes and misses never fetch.
 * Any failure resolves to the raw ticker — callers never see a throw.
 */
export async function resolveBreezeStockCode(symbol: string): Promise<string> {
  const sym = String(symbol || "").toUpperCase().trim();
  if (INDEX_BREEZE_CODES[sym]) return INDEX_BREEZE_CODES[sym];
  try {
    const map = await loadScripMap();
    return map.get(sym) ?? sym;
  } catch {
    return sym;
  }
}
