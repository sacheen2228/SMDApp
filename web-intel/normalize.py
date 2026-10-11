"""Phase 5 — Web Intelligence normalization.

Turns one RSS/Atom item into a provenance-rich record. Fields required by
the Phase 5 contract:

    source, url, publishedAt, collectedAt, symbol, eventType, sentiment,
    impact, confidence, freshness, provenance, hash

Classification (eventType / sentiment / impact / confidence) is DELIBERATELY
NOT done here — the TS sync layer reuses the existing news-lexicon /
sentiment-analyzer / news-intelligence (single source of truth, no duplicated
lexicon in Python). Raw rows store `symbols: []` and empty classification
slots; TS fills them once at sync.

`hash` = sha256(source + url + published_at + title) — stable across collector
restarts, so re-ingesting the same item is always a no-op (INSERT OR IGNORE).
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "media": "http://search.yahoo.com/mrss/",
}


def content_hash(source: str, url: str, published_at: str, title: str) -> str:
    raw = f"{source}|{url}|{published_at}|{title}".encode("utf-8", "replace")
    return hashlib.sha256(raw).hexdigest()


def _text(el: Any) -> str:
    if el is None:
        return ""
    txt = getattr(el, "text", None)
    if txt:
        return str(txt).strip()
    return (el.text or "").strip() if getattr(el, "text", None) is not None else str(el).strip()


def _child_text(item: Any, *names: str) -> str:
    for n in names:
        el = item.find(n, NS)
        if el is not None:
            v = _text(el)
            if v:
                return v
    return ""


def parse_pubdate(raw: str) -> str:
    """RFC822 or ISO-8601 → canonical ISO-8601 UTC. Falls back to epoch-safe ''."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError):
        pass
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return ""


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def strip_html(s: str) -> str:
    s = _TAG_RE.sub(" ", s or "")
    return _WS_RE.sub(" ", s).strip()


def normalize_item(item: Any, source: dict, collected_at: str) -> dict | None:
    """RSS/Atom <item> → raw provenance record dict (TS enriches later)."""
    title = strip_html(_child_text(item, "title"))
    link = _child_text(item, "link")
    if not link:
        # Atom: <link href="..."/>
        el = item.find("link", NS)
        if el is not None:
            link = (el.get("href") or "").strip()
    if not title or not link:
        return None

    published_raw = _child_text(item, "pubDate", "published", "updated", "{http://purl.org/dc/elements/1.1/}date")
    published_at = parse_pubdate(published_raw)
    if not published_at:
        # No trustworthy publish time → use collection time and flag it in
        # provenance (never invent a timestamp).
        published_at = collected_at

    description = strip_html(_child_text(item, "description", "summary", "content"))[:1000]

    # Backfill = collected long after it was published (PC was OFF / feed
    # gap). The ORIGINAL published_at is preserved — never rewritten.
    backfilled = False
    try:
        pub_ms = datetime.fromisoformat(published_at.replace("Z", "+00:00")).timestamp()
        col_ms = datetime.fromisoformat(collected_at.replace("Z", "+00:00")).timestamp()
        backfilled = (col_ms - pub_ms) > 6 * 3600  # >6h old at collection time
    except ValueError:
        pass

    provenance = {
        "collector": "scrapling",
        "kind": source.get("kind", "rss"),
        "category": source.get("category", "markets"),
        "weight": source.get("weight", 0.5),
        "feedUrl": source["url"],
        "publishedRaw": published_raw,
        "timeInvented": not parse_pubdate(published_raw),
        "collectedAt": collected_at,
    }

    return {
        "id": content_hash(source["name"], link, published_at, title),
        "source": source["name"],
        "source_feed": source["url"],
        "url": link,
        "title": title,
        "description": description,
        "published_at": published_at,
        "collected_at": collected_at,
        "backfilled": backfilled,
        "symbols": [],       # TS extracts at sync (news-lexicon)
        "provenance": provenance,
    }


def normalize_feed(xml_bytes: bytes, source: dict, collected_at: str) -> list[dict]:
    """Parse one RSS/Atom payload into normalized records (never raises)."""
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []
    items = root.findall(".//item") + root.findall(".//{http://www.w3.org/2005/Atom}entry")
    out: list[dict] = []
    for it in items:
        try:
            rec = normalize_item(it, source, collected_at)
            if rec:
                out.append(rec)
        except Exception:
            continue
    return out
