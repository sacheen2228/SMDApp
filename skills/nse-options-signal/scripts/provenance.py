#!/usr/bin/env python3
"""Provenance / data-quality layer for the NSE Options Signal skill.

Every scored input carries: name, source, data_timestamp, fetch_timestamp,
status (LIVE | FALLBACK | STALE | MISSING | UNAVAILABLE).

Nothing is ever invented: a missing timestamp or failed fetch is reported as
such; freshness for core inputs gates the decision in score_signal.
"""
import datetime as _dt

LIVE = "LIVE"
FALLBACK = "FALLBACK"
STALE = "STALE"
MISSING = "MISSING"
UNAVAILABLE = "UNAVAILABLE"

# Freshness TTLs (seconds) per input. Core inputs gate the decision.
TTL_SECONDS = {
    "option_chain": 900,      # SKILL.md: refresh every 5-15 min
    "spot": 900,
    "vix": 900,
    "greeks": 900,           # derived from option_chain
    "levels": 900,
    "heat_map": 900,
    "gainers": 900,
    "losers": 900,
    "oi_spurts": 900,
    "preopen": 900,
    "volume_gainers": 900,
    "week52_high": 900,
    "most_active_contracts": 900,
    "closing_auction": 79200,  # EOD input (22h) -> next-session usable
    "fii_dii": 129600,         # EOD (36h)
    "participant_oi": 129600,  # EOD (36h)
    "news": 21600,             # 6h
}

# Inputs the decision cannot be trusted without.
# 'greeks' and 'spot' are DERIVED from option_chain and inherit its freshness.
CORE_INPUTS = ["option_chain", "vix", "greeks"]

# Top-level snapshot sections -> provenance input name.
# ('groups' and 'news' are intentionally excluded: 'groups' is derived by
# the agent from feed sections, 'news' carries its own per-event timestamps.)
SECTION_INPUT_MAP = {
    "option_chain": "option_chain",
    "all_indices": "vix",
    "fii_dii": "fii_dii",
    "gainers": "gainers",
    "losers": "losers",
    "oi_spurts": "oi_spurts",
    "preopen": "preopen",
    "heatmap": "heatmap",
}

# Derived inputs: freshness = their parent section's freshness.
DERIVED_INPUTS = {"greeks": "option_chain", "spot": "option_chain"}

DEFAULT_TTL = 900


def _parse_ts(value):
    """Parse a timestamp string into aware-naive datetime (IST wall clock).
    Returns None if unparsable. Accepts ISO and the skill's usual formats."""
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = _dt.datetime.fromisoformat(text)
        if parsed.tzinfo is not None:
            # convert to IST-ish wall clock by dropping tz offset naive local
            parsed = parsed.astimezone().replace(tzinfo=None)
        return parsed
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S",
                "%d-%b-%Y %H:%M:%S", "%d-%b-%Y %H:%M"):
        try:
            return _dt.datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return None


def record_input(name, source, data_timestamp=None, fetch_timestamp=None,
                 status=None, is_fallback=False, attempts=1, url=None,
                 detail=None, now=None, ttl=None):
    """Build one provenance record.

    status rules (when not given explicitly):
      UNAVAILABLE  -> fetch failed (detail says why)
      MISSING      -> no data / no parseable timestamp
      STALE        -> age beyond ttl
      FALLBACK     -> is_fallback or attempts > 1 (secondary path used)
      LIVE         -> fresh primary data
    """
    ttl = TTL_SECONDS.get(name, DEFAULT_TTL) if ttl is None else ttl
    now_dt = _parse_ts(now) if now is not None else None
    data_dt = _parse_ts(data_timestamp)
    fetch_dt = _parse_ts(fetch_timestamp)

    if status is None:
        if detail and "fetch failed" in str(detail).lower():
            status = UNAVAILABLE
        elif data_dt is None and fetch_dt is None:
            status = MISSING
        elif data_dt is None:
            status = MISSING
        else:
            status = LIVE
            if is_fallback or attempts > 1:
                status = FALLBACK
            if now_dt is not None and (now_dt - data_dt).total_seconds() > ttl:
                status = STALE

    age_seconds = None
    if data_dt is not None and now_dt is not None:
        age_seconds = int((now_dt - data_dt).total_seconds())

    record = {
        "name": name,
        "source": source or None,
        "data_timestamp": data_timestamp or None,
        "fetch_timestamp": fetch_timestamp or None,
        "freshness_seconds": age_seconds,
        "ttl_seconds": ttl,
        "status": status,
    }
    if url:
        record["url"] = url
    if attempts and attempts > 1:
        record["attempts"] = attempts
    if detail:
        record["detail"] = detail
    return record


def build_data_quality(records, now=None, core_inputs=None):
    """Aggregate records into a data_quality object.

    overall: MISSING (a core input missing/unavailable) > STALE (core stale)
             > FALLBACK (any fallback) > LIVE.
    core_fresh: every core input present with a provable fresh timestamp.
    """
    core_inputs = CORE_INPUTS if core_inputs is None else core_inputs
    records = list(records or [])
    by_name = {r.get("name"): r for r in records}

    core_fresh = True
    for name in core_inputs:
        rec = by_name.get(name)
        if rec is None or rec.get("status") in (MISSING, UNAVAILABLE):
            core_fresh = False
        elif rec.get("status") == STALE:
            core_fresh = False
        elif rec.get("freshness_seconds") is None:
            # value present but timestamp unprovable -> freshness unknown
            core_fresh = False

    core_recs = [by_name[n] for n in core_inputs if n in by_name]
    core_statuses = [r.get("status") for r in core_recs]
    statuses = [r.get("status") for r in records]
    if any(s in (MISSING, UNAVAILABLE) for s in core_statuses):
        overall = MISSING
    elif any(s == STALE for s in core_statuses):
        overall = STALE
    elif any(s == STALE for s in statuses):
        overall = STALE
    elif any(s == FALLBACK for s in statuses):
        overall = FALLBACK
    elif any(s in (MISSING, UNAVAILABLE) for s in statuses):
        overall = MISSING
    else:
        overall = LIVE

    return {
        "overall": overall,
        "core_fresh": core_fresh,
        "core_inputs": list(core_inputs),
        "inputs": records,
    }


def records_from_snapshot(snapshot, now=None):
    """Read meta.provenance written by nse_fetch (or hand-built fixtures)
    and return (records, data_quality). Older snapshots without provenance
    produce explicit MISSING records for core inputs -> freshness gate fires
    rather than silently trusting undated data."""
    meta = (snapshot or {}).get("meta") or {}
    prov = meta.get("provenance")

    if isinstance(prov, list):
        records = []
        for r in prov:
            if not (isinstance(r, dict) and r.get("name")):
                continue
            if r.get("status") is None:
                rec = record_input(r.get("name"), r.get("source"),
                                   r.get("data_timestamp"), r.get("fetch_timestamp"),
                                   is_fallback=bool(r.get("is_fallback")),
                                   attempts=r.get("attempts", 1), url=r.get("url"),
                                   detail=r.get("detail"), now=now)
            else:
                rec = dict(r)
                if rec.get("freshness_seconds") is None and now is not None:
                    data_dt = _parse_ts(rec.get("data_timestamp"))
                    now_dt = _parse_ts(now)
                    if data_dt is not None and now_dt is not None:
                        rec["freshness_seconds"] = int((now_dt - data_dt).total_seconds())
            records.append(rec)
        known = {r["name"] for r in records}
    elif isinstance(prov, dict):
        records = []
        known = set()
        for name, val in prov.items():
            if isinstance(val, dict):
                orig_status = val.get("status")
                # recompute status against `now` so a stale snapshot ages
                # out (LIVE/FALLBACK/STALE re-evaluated, hard states kept)
                keep_status = orig_status if orig_status in (MISSING, UNAVAILABLE) else None
                rec = record_input(
                    name,
                    val.get("source", meta.get("source")),
                    val.get("data_timestamp"),
                    val.get("fetch_timestamp") or meta.get("data_timestamp"),
                    status=keep_status,
                    is_fallback=orig_status == FALLBACK,
                    attempts=val.get("attempts", 1),
                    url=val.get("url"),
                    detail=val.get("detail"),
                    now=now,
                )
            else:
                # plain timestamp value
                rec = record_input(name, meta.get("source"), val,
                                   meta.get("fetch_timestamp"), now=now)
            records.append(rec)
            known.add(name)
    else:
        records, known = [], set()

    # Sections present but carrying no provenance record -> explicit MISSING
    # record (timestamp unprovable -> freshness gate fires rather than
    # silently trusting undated data).
    present_input_names = set()
    for section, name in SECTION_INPUT_MAP.items():
        if section in snapshot and snapshot.get(section) is not None:
            present_input_names.add(name)
            if name not in known and not any(r["name"] == name for r in records):
                records.append(record_input(
                    name, meta.get("source"),
                    data_timestamp=meta.get("data_timestamp"),
                    fetch_timestamp=meta.get("fetch_timestamp"),
                    now=now, detail="timestamp missing - freshness unprovable"))

    # Derived inputs inherit their parent's provenance.
    by_name = {r["name"]: r for r in records}
    for derived, parent in DERIVED_INPUTS.items():
        if parent not in by_name:
            if derived in (snapshot or {}):
                records.append(record_input(
                    derived, "derived from %s" % parent, None, None, now=now,
                    detail="%s unavailable - %s missing" % (derived, parent)))
            continue
        parent_rec = by_name[parent]
        records.append(record_input(
            derived, "derived from %s" % parent,
            parent_rec.get("data_timestamp"),
            parent_rec.get("fetch_timestamp"),
            status=parent_rec.get("status"),
            now=now, detail="inherits freshness from %s" % parent))

    dq = build_data_quality(records, now=now)
    return records, dq


if __name__ == "__main__":
    import json, sys
    snap = json.load(open(sys.argv[1]))
    now = sys.argv[2] if len(sys.argv) > 2 else None
    _, dq = records_from_snapshot(snap, now=now)
    print(json.dumps(dq, indent=2))
