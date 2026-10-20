#!/usr/bin/env python3
"""Contract master - the ONLY source of lot sizes for this skill.

The authoritative contract master in this repository is
`src/lib/symbol-config.ts` (its F&O table is the NSE bhavcopy `NewBrdLotQty`
column).  This module never guesses a lot size: an unknown symbol resolves to
0 and the caller MUST fail closed.

Resolution order:
  1. <data-dir>/contract_lots.json   - live map (e.g. dropped by the app from
     the NSE bhavcopy provider src/lib/data-layer/providers/bhavcopy.ts)
  2. <skill>/references/contract-lots.json - checked-in snapshot of the repo's
     symbol-config.ts, refreshed with:
         python3 scripts/contract_master.py --refresh

Usage:
    from contract_master import lot_size, provenance
    lot = lot_size("RELIANCE")      # 500
    lot_size("NOSUCH")              # 0  -> fail closed
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
DEFAULT_DATA_DIR = os.environ.get("GEX_DATA_DIR", os.path.join(SKILL, "data"))
REPO_ROOT = os.environ.get("SMDAPP_ROOT", os.path.dirname(os.path.dirname(SKILL)))
SYMBOL_CONFIG_TS = os.path.join(REPO_ROOT, "src", "lib", "symbol-config.ts")
CHECKED_IN = os.path.join(SKILL, "references", "contract-lots.json")

UNKNOWN_LOT = 0


def _read_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def _parse_symbol_config(text):
    """Extract {symbol: lot} from src/lib/symbol-config.ts."""
    lots = {}

    m = re.search(r"NSE_FO_LOT_SIZES[^=]*=\s*\{(.*?)\n\};", text, re.S)
    if m:
        block = m.group(1)
        for key, val in re.findall(r'"([^"]+)"\s*:\s*(\d+)', block):
            lots[key.upper()] = int(val)
        for key, val in re.findall(r"(?<![\"\w])([A-Za-z][A-Za-z0-9&]*)\s*:\s*(\d+)", block):
            lots.setdefault(key.upper(), int(val))

    m = re.search(r"SYMBOL_CONFIGS[^=]*=\s*\{(.*?)\n\};", text, re.S)
    if m:
        block = m.group(1)
        for sym_chunk in re.split(r'symbol:\s*"', block)[1:]:
            name = sym_chunk.split('"')[0].strip().upper()
            tail = sym_chunk.split("}", 1)[0]
            lm = re.search(r"lotSize:\s*(\d+)", tail)
            if name and lm:
                lots[name] = int(lm.group(1))
    return lots


def refresh(out_path=CHECKED_IN, repo_root=REPO_ROOT):
    """Regenerate the checked-in lot map from the repo's symbol-config.ts."""
    path = os.path.join(repo_root, "src", "lib", "symbol-config.ts")
    if not os.path.exists(path):
        raise SystemExit("contract master not found: %s" % path)
    with open(path) as fh:
        lots = _parse_symbol_config(fh.read())
    if not lots:
        raise SystemExit("no lot sizes parsed from %s" % path)
    payload = {
        "_comment": "Lot sizes for the nse-options-signal skill. GENERATED - do not hand-edit. "
                    "Source of truth: src/lib/symbol-config.ts (NSE F&O bhavcopy NewBrdLotQty). "
                    "Refresh: python3 scripts/contract_master.py --refresh",
        "source": "src/lib/symbol-config.ts",
        "source_file": os.path.relpath(path, repo_root),
        "lots": lots,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as fh:
        json.dump(payload, fh, indent=1, sort_keys=True)
    return payload


def _load_all(data_dir=None):
    """Return (lots, provenance_map) from the live file then the checked-in file."""
    data_dir = data_dir or DEFAULT_DATA_DIR
    lots, prov = {}, {}
    live = _read_json(os.path.join(data_dir, "contract_lots.json"))
    if isinstance(live, dict):
        src = live.get("source") or "data/contract_lots.json"
        raw = live.get("lots") if isinstance(live.get("lots"), dict) else live
        for k, v in (raw or {}).items():
            if isinstance(v, dict):
                v = v.get("lot")
            try:
                lots[str(k).upper()] = int(v)
                prov[str(k).upper()] = src
            except Exception:
                continue
    checked = _read_json(CHECKED_IN)
    if isinstance(checked, dict):
        src = checked.get("source") or CHECKED_IN
        for k, v in (checked.get("lots") or {}).items():
            key = str(k).upper()
            if key not in lots:
                lots[key] = int(v)
                prov[key] = src
    return lots, prov


_LOTS, _PROV = _load_all()


def reload(data_dir=None):
    global _LOTS, _PROV
    _LOTS, _PROV = _load_all(data_dir)
    return _LOTS


def lot_size(symbol, data_dir=None):
    """Lot size of `symbol`, or 0 when unknown (callers must fail closed)."""
    if data_dir is not None:
        lots, _ = _load_all(data_dir)
    else:
        lots = _LOTS
    if not symbol:
        return UNKNOWN_LOT
    key = str(symbol).strip().upper()
    if key in lots:
        return int(lots[key])
    # index aliases used by the live feeds
    alias = {"NIFTY 50": "NIFTY", "NIFTY50": "NIFTY", "NIFTY BANK": "BANKNIFTY",
             "NIFTY BANK": "BANKNIFTY", "NIFTY IT": "FINNIFTY", "NIFTY MIDCAP 100": "MIDCPNIFTY",
             "NIFTY NEXT 50": "NIFTYNXT50", "BANK NIFTY": "BANKNIFTY", "FIN NIFTY": "FINNIFTY"}
    if key in alias and alias[key] in lots:
        return int(lots[alias[key]])
    return UNKNOWN_LOT


def provenance(symbol, data_dir=None):
    if data_dir is not None:
        _, prov = _load_all(data_dir)
    else:
        prov = _PROV
    key = str(symbol or "").strip().upper()
    return prov.get(key, "unknown")


if __name__ == "__main__":
    if "--refresh" in sys.argv:
        payload = refresh()
        print("wrote %s with %d symbols" % (CHECKED_IN, len(payload["lots"])))
        raise SystemExit(0)
    for sym in sys.argv[1:]:
        print("%s lot=%s source=%s" % (sym, lot_size(sym), provenance(sym)))
    if not sys.argv[1:]:
        print("NIFTY lot=%s source=%s" % (lot_size("NIFTY"), provenance("NIFTY")))
        print("RELIANCE lot=%s source=%s" % (lot_size("RELIANCE"), provenance("RELIANCE")))
        print("UNKNOWN lot=%s (fail closed)" % lot_size("NOSUCHSYMBOL"))
