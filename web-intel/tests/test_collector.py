#!/usr/bin/env python3
"""Phase 5 — Web Intelligence collector tests (stdlib unittest).

Covers: normalization, content-hash dedup, PC-off/backfill preservation,
source failure isolation, offline queue durability, Scrapling collection
(live --once covered separately by scripts/run-live-once.sh).
Run: python3 -m unittest discover -s web-intel/tests -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from xml.etree.ElementTree import Element, SubElement, tostring

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from normalize import content_hash, normalize_feed, normalize_item, parse_pubdate  # noqa: E402
from sources import SOURCES  # noqa: E402

RSS = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>T</title>
<item><title>RBI hikes repo rate 25 bps</title>
<link>https://example.com/a1</link>
<pubDate>Tue, 07 Oct 2026 09:30:00 GMT</pubDate>
<description>&lt;p&gt;Policy decision&lt;/p&gt;</description></item>
<item><title></title><link>https://example.com/broken</link></item>
</channel></rss>"""


def make_item(title="NIFTY surges 1%", link="https://e.com/x", pub="Tue, 07 Oct 2026 10:00:00 GMT"):
    it = Element("item")
    SubElement(it, "title").text = title
    SubElement(it, "link").text = link
    if pub is not None:
        SubElement(it, "pubDate").text = pub
    SubElement(it, "description").text = "desc"
    return it


SRC = {"name": "UnitSource", "url": "https://feeds.example/rss", "kind": "rss",
       "category": "markets", "weight": 0.9}


class TestNormalize(unittest.TestCase):
    def test_required_fields_present(self):
        rec = normalize_item(make_item(), SRC, "2026-10-07T12:00:00Z")
        for f in ("id", "source", "url", "published_at", "collected_at",
                  "backfilled", "symbols", "provenance"):
            self.assertIn(f, rec)
        self.assertEqual(rec["source"], "UnitSource")
        self.assertEqual(rec["provenance"]["feedUrl"], SRC["url"])
        self.assertEqual(rec["published_at"], "2026-10-07T10:00:00Z")

    def test_html_stripped(self):
        rec = normalize_item(make_item(title="<b>NIFTY</b> up"), SRC, "2026-10-07T12:00:00Z")
        self.assertEqual(rec["title"], "NIFTY up")

    def test_missing_title_skipped(self):
        rec = normalize_item(make_item(title=""), SRC, "2026-10-07T12:00:00Z")
        self.assertIsNone(rec)

    def test_feed_parse_skips_broken_items(self):
        recs = normalize_feed(RSS.encode(), SRC, "2026-10-07T12:00:00Z")
        self.assertEqual(len(recs), 1)
        self.assertIn("RBI hikes", recs[0]["title"])

    def test_garbage_feed_no_raise(self):
        self.assertEqual(normalize_feed(b"not xml at all", SRC, "2026-10-07T12:00:00Z"), [])

    def test_pubdate_iso_and_rfc822(self):
        self.assertEqual(parse_pubdate("Tue, 07 Oct 2026 09:30:00 GMT"), "2026-10-07T09:30:00Z")
        self.assertEqual(parse_pubdate("2026-10-07T09:30:00Z"), "2026-10-07T09:30:00Z")
        self.assertEqual(parse_pubdate("nonsense"), "")


class TestDedup(unittest.TestCase):
    def test_hash_stable(self):
        a = content_hash("S", "https://u", "2026-10-07T10:00:00Z", "T")
        b = content_hash("S", "https://u", "2026-10-07T10:00:00Z", "T")
        self.assertEqual(a, b)
        self.assertEqual(len(a), 64)

    def test_hash_differs_on_fields(self):
        base = content_hash("S", "https://u", "2026-10-07T10:00:00Z", "T")
        self.assertNotEqual(base, content_hash("S2", "https://u", "2026-10-07T10:00:00Z", "T"))
        self.assertNotEqual(base, content_hash("S", "https://u", "2026-10-07T11:00:00Z", "T"))

    def test_same_item_twice_same_id(self):
        r1 = normalize_item(make_item(), SRC, "2026-10-07T12:00:00Z")
        r2 = normalize_item(make_item(), SRC, "2026-10-07T13:00:00Z")
        self.assertEqual(r1["id"], r2["id"])  # collected_at NOT part of hash


class TestPcOffBackfill(unittest.TestCase):
    def test_original_published_at_preserved_when_old(self):
        """PC was off for 2 days — item published 2 days ago must keep its
        ORIGINAL published_at and be flagged backfilled (never fresh)."""
        rec = normalize_item(
            make_item(pub="Mon, 05 Oct 2026 10:00:00 GMT"),
            SRC, "2026-10-07T12:00:00Z")
        self.assertEqual(rec["published_at"], "2026-10-05T10:00:00Z")  # original, not rewritten
        self.assertEqual(rec["collected_at"], "2026-10-07T12:00:00Z")
        self.assertTrue(rec["backfilled"])

    def test_recent_item_not_backfilled(self):
        rec = normalize_item(
            make_item(pub="Tue, 07 Oct 2026 11:55:00 GMT"),
            SRC, "2026-10-07T12:00:00Z")
        self.assertFalse(rec["backfilled"])

    def test_no_pubdate_never_invented_fresh(self):
        rec = normalize_item(make_item(pub=None), SRC, "2026-10-07T12:00:00Z")
        # Falls back to collected_at (honest: we don't know) + flags it.
        self.assertEqual(rec["published_at"], "2026-10-07T12:00:00Z")
        self.assertTrue(rec["provenance"]["timeInvented"])


class TestSourceFailure(unittest.TestCase):
    def test_registry_entries_valid(self):
        names = set()
        for s in SOURCES:
            self.assertIn("name", s)
            self.assertIn("url", s)
            self.assertTrue(s["url"].startswith("https://"))
            self.assertNotIn(s["name"], names, "duplicate source name")
            names.add(s["name"])
        self.assertGreaterEqual(len(SOURCES), 10)

    def test_fetch_failure_isolated_per_source(self):
        """A failing source must not prevent others from normalizing."""
        good = normalize_feed(RSS.encode(), SRC, "2026-10-07T12:00:00Z")
        bad = normalize_feed(b"<html>503 blocked</html>", SRC, "2026-10-07T12:00:00Z")
        self.assertEqual(len(good), 1)
        self.assertEqual(len(bad), 0)  # degraded, not crashed

    def test_collector_imports_and_handles_offline_store(self):
        import collector

        with tempfile.TemporaryDirectory() as td:
            collector.QUEUE_FILE = os.path.join(td, "pending.jsonl")
            collector.STATE_FILE = os.path.join(td, "state.json")
            old_base = collector.BASE
            collector.BASE = "http://127.0.0.1:59999"  # nothing listens → offline
            try:
                resp = collector.ingest([{"id": "x", "source": "s", "url": "u",
                                          "title": "t", "published_at": "p",
                                          "collected_at": "c"}])
                self.assertIsNone(resp)  # failure → queued, never lost
                queued = collector._drain_queue()
                self.assertEqual(len(queued), 1)
                self.assertEqual(queued[0]["id"], "x")
                # Queue file is gone after drain (drained exactly once)
                self.assertFalse(os.path.exists(collector.QUEUE_FILE))
            finally:
                collector.BASE = old_base

    def test_state_roundtrip(self):
        import collector

        with tempfile.TemporaryDirectory() as td:
            collector.STATE_FILE = os.path.join(td, "state.json")
            collector._save_state({"lastRun": {"inserted": 3}})
            self.assertEqual(collector.load_state()["lastRun"]["inserted"], 3)
            self.assertEqual(collector.load_state().get("missing", {}), {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
