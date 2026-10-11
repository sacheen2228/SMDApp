#!/usr/bin/env python3
"""Phase 5 — Web Intelligence collector (Scrapling).

Always-on systemd service. Fetches free public RSS sources with Scrapling
(curl_cffi browser impersonation), normalizes them into provenance-rich raw
records, and POSTs them to the market-history central store (:4002).

Design guarantees
  • Dedup        — content-hash id; re-ingesting the same item is a no-op.
  • PC-OFF       — original published_at/collected_at are preserved; a queue
                   file (queue/pending.jsonl) holds batches when :4002 is
                   unreachable, flushed on the next run. Nothing is ever
                   claimed as collected while the machine was off.
  • Source fail  — one bad source never stops the others (per-source try),
                   health reported via heartbeat.
  • Evidence     — raw collection only. Classification/enrichment happens in
                   the TS sync layer with the EXISTING lexicon. News never
                   creates a trade.

Usage
  python3 collector.py --once            single collection pass (tests/live)
  python3 collector.py                   continuous loop (systemd)
  python3 collector.py --interval 300    loop with custom seconds
  python3 collector.py --status          print last local state and exit
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from sources import SOURCES  # noqa: E402
from normalize import normalize_feed  # noqa: E402

BASE = os.environ.get("MARKET_HISTORY_BASE", "http://127.0.0.1:4002")
QUEUE_FILE = os.path.join(HERE, "queue", "pending.jsonl")
STATE_FILE = os.path.join(HERE, "queue", "state.json")
VERSION = "0.1.0"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ── Fetch layer: Scrapling primary, urllib fallback ──────────────────
def fetch(url: str, timeout: int = 25) -> tuple[bytes, str]:
    """Returns (body, fetcher_name). Raises on total failure."""
    try:
        from scrapling.fetchers import Fetcher  # optional heavy dep

        r = Fetcher.get(url, timeout=timeout, impersonate="chrome", follow_redirects=True)
        status = getattr(r, "status", 0)
        body = getattr(r, "body", None) or b""
        if status and int(status) >= 400:
            raise RuntimeError(f"HTTP {status}")
        if not body:
            raise RuntimeError("empty body")
        return body, "scrapling"
    except ImportError:
        pass  # fall through to stdlib
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return resp.read(), "urllib"


# ── Queue (durability across :4002 downtime) ─────────────────────────
def _append_queue(records: list[dict]) -> None:
    if not records:
        return
    os.makedirs(os.path.dirname(QUEUE_FILE), exist_ok=True)
    with open(QUEUE_FILE, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def _drain_queue() -> list[dict]:
    if not os.path.exists(QUEUE_FILE):
        return []
    rows: list[dict] = []
    try:
        with open(QUEUE_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        os.remove(QUEUE_FILE)
    except OSError:
        return []
    return rows


def _save_state(state: dict) -> None:
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


# ── HTTP to central store ────────────────────────────────────────────
def _post(path: str, payload: dict, timeout: int = 15) -> dict:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
        return json.loads(resp.read().decode("utf-8"))


def ingest(records: list[dict]) -> dict | None:
    """POST batch to central store. Returns response or None (queue it)."""
    if not records:
        return {"inserted": 0, "duplicates": 0}
    try:
        return _post("/api/web/ingest", {"records": records})
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"[web-intel] ingest unavailable ({e}); queueing {len(records)}", flush=True)
        _append_queue(records)
        return None


def heartbeat(state: dict) -> None:
    try:
        _post("/api/web/heartbeat", state, timeout=10)
    except Exception as e:  # heartbeat failure must never kill the loop
        print(f"[web-intel] heartbeat failed: {e}", flush=True)


# ── One collection pass ──────────────────────────────────────────────
def collect_once() -> dict:
    collected_at = now_iso()
    new_records: list[dict] = []
    health: list[dict] = []

    for src in SOURCES:
        try:
            body, fetcher = fetch(src["url"])
            recs = normalize_feed(body, src, collected_at)
            for r in recs:
                r["provenance"]["fetcher"] = fetcher
            new_records.extend(recs)
            health.append({"source": src["name"], "status": "OK", "ok": True, "error": None})
        except Exception as e:
            health.append({"source": src["name"], "status": "FAIL", "ok": False,
                           "error": str(e)[:200]})
        time.sleep(0.4)  # politeness between sources

    # Flush anything queued while :4002 / PC was down FIRST (original
    # collected_at preserved — honest backfill).
    pending = _drain_queue()
    all_records = pending + new_records

    resp = ingest(all_records)
    inserted = resp.get("inserted", 0) if resp else 0
    duplicates = resp.get("duplicates", 0) if resp else 0

    state = {
        "status": "ONLINE",
        "lastHeartbeatAt": now_iso(),
        "lastCollectionAt": collected_at,
        "recordsTotal": None,           # filled below when known
        "recordsThisRun": inserted,
        "lastError": next((h["error"] for h in health if not h["ok"]), None),
        "collectorVersion": VERSION,
        "sources": health,
    }
    if resp is not None:
        state["recordsTotal"] = resp.get("total")
    heartbeat(state)

    summary = {
        "collectedAt": collected_at,
        "fetched": len(new_records),
        "flushedFromQueue": len(pending),
        "inserted": inserted,
        "duplicates": duplicates,
        "queueLength": 0 if resp is not None else len(all_records),
        "sourcesOk": sum(1 for h in health if h["ok"]),
        "sourcesFail": sum(1 for h in health if not h["ok"]),
        "failed": [h["source"] for h in health if not h["ok"]],
    }
    _save_state({**load_state(), "lastRun": summary, "version": VERSION})
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description="SMDApp Web Intelligence collector")
    ap.add_argument("--once", action="store_true", help="single pass then exit")
    ap.add_argument("--interval", type=int, default=int(os.environ.get("WEB_INTEL_INTERVAL", "300")),
                    help="loop interval seconds (default 300)")
    ap.add_argument("--status", action="store_true", help="print last local state")
    args = ap.parse_args()

    if args.status:
        print(json.dumps(load_state(), indent=2))
        return 0

    if args.once:
        summary = collect_once()
        print(json.dumps(summary, indent=2))
        # Non-zero when EVERY source failed (real outage) — tests assert on this.
        return 0 if summary["sourcesOk"] > 0 else 2

    print(f"[web-intel] starting, interval={args.interval}s, base={BASE}", flush=True)
    while True:
        try:
            summary = collect_once()
            print(f"[web-intel] {json.dumps(summary)}", flush=True)
        except Exception as e:  # loop must survive anything
            print(f"[web-intel] run failed: {e}", flush=True)
            heartbeat({"status": "ERROR", "lastError": str(e)[:200],
                       "collectorVersion": VERSION, "lastHeartbeatAt": now_iso()})
        time.sleep(max(30, args.interval))


if __name__ == "__main__":
    sys.exit(main())
