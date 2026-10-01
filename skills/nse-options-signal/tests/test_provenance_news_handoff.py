#!/usr/bin/env python3
"""Tests: provenance/data-quality, news+sentiment context, Grok handoff.
Offline + deterministic (fixed clock, synthetic fixtures). No network."""
import datetime as dt
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fixtures
import provenance
import news_context
import grok_handoff
from score_signal import score_snapshot

NOW = fixtures.NOW


def _gate(out, needle):
    return any(needle in str(g) for g in out.get("gates_failed", []))


class TestProvenance(unittest.TestCase):
    def test_fresh_core_no_freshness_gate(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        self.assertFalse(_gate(out, "DATA_FRESHNESS"))
        self.assertTrue(out["data_quality"]["core_fresh"])
        self.assertEqual(out["data_quality"]["overall"], "LIVE")

    def test_stale_core_input_gates(self):
        snap = fixtures.base_snapshot()
        snap["meta"]["provenance"]["option_chain"]["data_timestamp"] = \
            (NOW - dt.timedelta(hours=2)).strftime("%Y-%m-%d %H:%M:%S")
        out = score_snapshot(snap, now=NOW)
        self.assertTrue(_gate(out, "DATA_FRESHNESS"))
        self.assertEqual(out["action"], "NO_TRADE")
        statuses = {r["name"]: r["status"] for r in out["data_quality"]["inputs"]}
        self.assertEqual(statuses.get("option_chain"), provenance.STALE)

    def test_missing_timestamp_gates(self):
        snap = fixtures.base_snapshot()
        del snap["meta"]["provenance"]["option_chain"]
        out = score_snapshot(snap, now=NOW)
        self.assertTrue(_gate(out, "DATA_FRESHNESS"))
        statuses = {r["name"]: r["status"] for r in out["data_quality"]["inputs"]}
        self.assertEqual(statuses.get("option_chain"), provenance.MISSING)

    def test_unavailable_fetch_gates(self):
        snap = fixtures.base_snapshot()
        snap["meta"]["provenance"]["option_chain"] = {
            "source": "NSE India", "data_timestamp": None,
            "fetch_timestamp": NOW.strftime("%Y-%m-%d %H:%M:%S"),
            "status": provenance.UNAVAILABLE, "detail": "fetch failed /api/option-chain",
        }
        out = score_snapshot(snap, now=NOW)
        self.assertTrue(_gate(out, "DATA_FRESHNESS"))
        statuses = {r["name"]: r["status"] for r in out["data_quality"]["inputs"]}
        self.assertEqual(statuses.get("option_chain"), provenance.UNAVAILABLE)

    def test_fallback_reported_but_not_gated(self):
        snap = fixtures.base_snapshot()
        prov = snap["meta"]["provenance"]["option_chain"]
        prov["status"] = provenance.FALLBACK
        prov["attempts"] = 3
        out = score_snapshot(snap, now=NOW)
        self.assertFalse(_gate(out, "DATA_FRESHNESS"))
        self.assertTrue(out["data_quality"]["core_fresh"])
        statuses = {r["name"]: r["status"] for r in out["data_quality"]["inputs"]}
        self.assertEqual(statuses.get("option_chain"), provenance.FALLBACK)

    def test_greeks_derives_option_chain_freshness(self):
        records, dq = provenance.records_from_snapshot(fixtures.base_snapshot(), now=NOW)
        by_name = {r["name"]: r for r in records}
        self.assertIn("greeks", by_name)
        self.assertEqual(by_name["greeks"]["status"], provenance.LIVE)
        self.assertIn("inherits freshness from option_chain",
                      by_name["greeks"].get("detail", ""))

    def test_record_input_rules(self):
        rec = provenance.record_input("x", "src", None, None, now=NOW)
        self.assertEqual(rec["status"], provenance.MISSING)
        rec = provenance.record_input(
            "x", "src", "2026-09-25 10:00:00", "2026-09-25 10:00:00",
            is_fallback=True, now=NOW)
        self.assertEqual(rec["status"], provenance.FALLBACK)
        rec = provenance.record_input(
            "x", "src", "2026-09-25 07:00:00", "2026-09-25 10:00:00", now=NOW)
        self.assertEqual(rec["status"], provenance.STALE)
        rec = provenance.record_input(
            "x", "src", None, "2026-09-25 10:00:00",
            detail="fetch failed /api/y", now=NOW)
        self.assertEqual(rec["status"], provenance.UNAVAILABLE)


class TestNewsSentiment(unittest.TestCase):
    def test_no_news_present_false_neutral(self):
        ctx = news_context.build_news_context([], NOW)
        self.assertFalse(ctx["present"])
        self.assertEqual(ctx["sentiment"]["score"], 0.0)
        self.assertEqual(ctx["sentiment"]["dominant"], "NEUTRAL")
        self.assertEqual(ctx["events"], [])

    def test_dedupe_by_event_id_impact_not_multiplied(self):
        snap = fixtures.base_snapshot()
        ctx = news_context.build_news_context(snap["news"], NOW)
        policy = [e for e in ctx["events"] if e["event_id"] == "evt_policy"]
        self.assertEqual(len(policy), 1)
        self.assertEqual(policy[0]["impact"], 70)          # max, not 70+65
        self.assertEqual(policy[0]["deduped_count"], 2)
        self.assertEqual(policy[0]["confidence"], 90)      # 85 + 5 (one corroboration)
        self.assertLessEqual(policy[0]["confidence"], 100)

    def test_unverified_social_not_counted_in_sentiment(self):
        social = [{"event_id": "s1", "source": "twitter:handle", "channel": "social",
                   "headline": "whisper rally", "published_at": "2026-09-25 09:40:00",
                   "received_at": "2026-09-25 09:41:00", "event_type": "MOOD",
                   "sentiment": 1, "impact": 90, "confidence": 90,
                   "market_wide": True}]
        ctx = news_context.build_news_context(social, NOW)
        self.assertTrue(ctx["present"])
        self.assertEqual(ctx["sentiment"]["score"], 0.0)   # unverified contributes 0
        self.assertEqual(ctx["sentiment"]["n_unverified"], 1)
        self.assertEqual(ctx["sentiment"]["unverified_headlines"][0]["status"],
                         "UNVERIFIED")

    def test_social_with_non_social_corroboration_counts(self):
        event = {"event_id": "s1", "source": "twitter:handle",
                 "corroborated_by": ["Reuters"],
                 "headline": "corroborated whisper", "published_at": "2026-09-25 09:40:00",
                 "received_at": "2026-09-25 09:41:00", "event_type": "MOOD",
                 "sentiment": 1, "impact": 50, "confidence": 40, "market_wide": True}
        ctx = news_context.build_news_context([event], NOW)
        self.assertEqual(ctx["sentiment"]["n_unverified"], 0)
        self.assertGreater(ctx["sentiment"]["score"], 0)

    def test_lookahead_published_after_decision_excluded(self):
        snap = fixtures.base_snapshot()
        ctx = news_context.build_news_context(snap["news"], NOW)
        ids = [e["event_id"] for e in ctx["events"]]
        self.assertNotIn("evt_lookahead", ids)
        excluded_ids = [e["event_id"] for e in ctx["excluded_lookahead"]]
        self.assertIn("evt_lookahead", excluded_ids)
        self.assertEqual(ctx["excluded_lookahead"][0]["reason"],
                         news_context.LOOKAHEAD_EXCLUDED)

    def test_lookahead_received_after_decision_excluded(self):
        event = {"event_id": "late", "source": "Mint",
                 "headline": "arrived late", "published_at": "2026-09-25 09:00:00",
                 "received_at": "2026-09-25 11:00:00", "event_type": "MOOD",
                 "sentiment": -1, "impact": 60, "confidence": 60,
                 "market_wide": True, "verified": True}
        ctx = news_context.build_news_context([event], NOW)
        self.assertEqual(ctx["events"], [])
        self.assertEqual(ctx["excluded_lookahead"][0]["event_id"], "late")

    def test_sentiment_bounds_and_dominant(self):
        snap = fixtures.base_snapshot()
        sentiment = news_context.build_news_context(snap["news"], NOW)["sentiment"]
        self.assertGreaterEqual(sentiment["score"], -1.0)
        self.assertLessEqual(sentiment["score"], 1.0)
        self.assertEqual(sentiment["dominant"], "BULLISH")

    def test_price_confirmation_states(self):
        bull = {"sentiment": 1}
        self.assertEqual(news_context.classify_confirmation(bull, {}), "UNKNOWN")
        self.assertEqual(
            news_context.classify_confirmation(bull, {"price_change_after_event": 1.2}),
            "CONFIRMED")
        self.assertEqual(
            news_context.classify_confirmation(bull, {"price_change_after_event": -1.2}),
            "NOT_CONFIRMED")
        self.assertEqual(
            news_context.classify_confirmation(
                bull, {"price_change_after_event": 1.0, "volume_change": -5.0}),
            "PARTIALLY_CONFIRMED")

    def test_conflict_surfaced_news_vs_market(self):
        events = [{"event_id": "e", "source": "Reuters", "headline": "risk-on",
                   "sentiment": 1, "impact": 70, "confidence": 80}]
        conflicts = news_context.conflicting_news(events, "BEARISH")
        self.assertEqual(conflicts[0]["code"], "NEWS_BULLISH_vs_MARKET_BEARISH")

    def test_news_never_changes_decision_or_score(self):
        snap = fixtures.bearish_snapshot()
        baseline = score_snapshot(snap, now=NOW)
        snap["news"] = snap["news"] + [{
            "event_id": "bull_trap", "source": "Bloomberg",
            "headline": "Massive buy program incoming",
            "published_at": "2026-09-25 09:30:00",
            "received_at": "2026-09-25 09:31:00", "event_type": "MOOD",
            "sentiment": 1, "impact": 95, "confidence": 99, "market_wide": True,
            "verified": True, "source_reliability": 0.95}]
        with_news = score_snapshot(snap, now=NOW)
        self.assertEqual(with_news["action"], baseline["action"])
        self.assertEqual(with_news["bias_score"], baseline["bias_score"])
        self.assertEqual(with_news["component_scores"], baseline["component_scores"])
        self.assertEqual(with_news["action"], "BUY_PE")

    def test_news_cannot_force_subthreshold_trade(self):
        snap = fixtures.base_snapshot()
        snap.pop("groups", None)
        snap["gainers"] = {}
        snap["losers"] = {}
        snap["fii_dii"] = [{"category": "FII", "netValue": 600.0}]
        snap["news"] = [{"event_id": "max", "source": "Reuters",
                         "headline": "Everything bullish forever",
                         "published_at": "2026-09-25 08:00:00",
                         "received_at": "2026-09-25 08:01:00", "event_type": "MOOD",
                         "sentiment": 1, "impact": 100, "confidence": 100,
                         "market_wide": True, "verified": True,
                         "source_reliability": 0.95}]
        out = score_snapshot(snap, now=NOW)
        self.assertEqual(out["action"], "NO_TRADE")
        self.assertLess(abs(out["bias_score"]), 40)
        self.assertGreater(out["sentiment_context"]["score"], 0.5)

    def test_news_schema_required_fields_normalized(self):
        events, excluded = news_context.normalize_events(
            [{"headline": "no ids", "sentiment": 1, "impact": 999}], NOW)
        self.assertEqual(events[0]["impact"], 100)  # clamped
        self.assertTrue(events[0]["event_id"].startswith("evt_"))
        self.assertEqual(events[0]["event_type"], "OTHER")


class TestGrokHandoff(unittest.TestCase):
    def test_handoff_labels_and_authority(self):
        out = score_snapshot(fixtures.base_snapshot(), now=NOW)
        handoff = grok_handoff.build_handoff(out, symbol="NIFTY")
        self.assertEqual(handoff["source"], grok_handoff.SOURCE)
        self.assertEqual(handoff["source"], "NSE_OPTIONS_SIGNAL")
        self.assertEqual(handoff["role"], grok_handoff.ROLE)
        self.assertEqual(handoff["role"], "OPTIONS_RESEARCH_SECOND_OPINION")
        self.assertEqual(handoff["authority"], "RESEARCH_INPUT_ONLY")
        self.assertFalse(handoff["can_force_trade"])
        self.assertFalse(handoff["supersedes_supervisor"])
        self.assertEqual(handoff["symbol"], "NIFTY")
        self.assertEqual(handoff["decision"], out["action"])
        self.assertEqual(handoff["signal"]["bias_score"], out["bias_score"])

    def test_handoff_risk_flags(self):
        stale = fixtures.base_snapshot()
        stale["meta"]["provenance"]["option_chain"]["data_timestamp"] = \
            (NOW - dt.timedelta(hours=3)).strftime("%Y-%m-%d %H:%M:%S")
        out = score_snapshot(stale, now=NOW)
        handoff = grok_handoff.build_handoff(out)
        self.assertIn("DATA_NOT_FRESH", handoff["risk_flags"])

        # ceiling-detectable snapshot: only three groups available
        weak = fixtures.base_snapshot()
        weak.pop("groups", None)
        weak["gainers"] = {}
        weak["losers"] = {}
        out2 = score_snapshot(weak, now=NOW)
        self.assertTrue(out2["score_ceiling"]["detected"])
        handoff2 = grok_handoff.build_handoff(out2)
        self.assertIn("SCORE_CEILING_DETECTED", handoff2["risk_flags"])

    def test_handoff_json_serializable(self):
        out = score_snapshot(fixtures.bearish_snapshot(), now=NOW)
        payload = grok_handoff.handoff_json(out, symbol="NIFTY")
        parsed = json.loads(payload)
        self.assertEqual(parsed["source"], "NSE_OPTIONS_SIGNAL")


if __name__ == "__main__":
    unittest.main(verbosity=2)
