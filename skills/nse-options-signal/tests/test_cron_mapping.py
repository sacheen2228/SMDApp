#!/usr/bin/env python3
"""Offline tests for the cron mapping and the trading-day gate.

The repo already owns a scheduler (scripts/dailyScanCron.ts + the systemd
timers).  The skill's jobs are registered there, so these tests check that the
mapping is complete and consistent - they never install a second crontab.
"""
import datetime as dt
import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(SKILL))
sys.path.insert(0, os.path.join(SKILL, "scripts"))

import trading_day  # noqa: E402

REGISTRY = os.path.join(REPO, "src", "lib", "orchestrator", "skill-jobs.ts")
CRON_DOC = os.path.join(SKILL, "config", "crontab.txt")
WRAPPER = os.path.join(SKILL, "scripts", "cron_job.sh")
SCHEDULER = os.path.join(REPO, "scripts", "dailyScanCron.ts")

EXPECTED = {
    "eod-pcr": "35 15 * * 1-5",
    "eod-fetch": "5 19 * * 1-5",
    "daily-bias": "30 8 * * 1-5",
    "live-breadth": "*/5 9-14 * * 1-5",
    "gex-engine": "*/5 9-14 * * 1-5",
    "holidays": "0 10 * * 0",
}


def registry_text():
    with open(REGISTRY) as fh:
        return fh.read()


class TestCronMapping(unittest.TestCase):
    def test_the_registry_holds_every_job(self):
        text = registry_text()
        for name, schedule in EXPECTED.items():
            self.assertIn('name: "%s"' % name, text, "job %s is missing" % name)
            self.assertIn('schedule: "%s"' % schedule, text,
                          "job %s has the wrong schedule" % name)

    def test_the_scheduler_registers_the_registry(self):
        with open(SCHEDULER) as fh:
            text = fh.read()
        self.assertIn("SKILL_JOBS", text)
        self.assertIn("runSkillJob", text)
        self.assertIn("skill-jobs", text)

    def test_the_cron_document_maps_every_job(self):
        with open(CRON_DOC) as fh:
            text = fh.read()
        for name in EXPECTED:
            self.assertIn(name, text, "job %s is not documented" % name)
        self.assertIn("not an installable crontab", text)
        self.assertIn("scripts/dailyScanCron.ts", text)

    def test_the_wrapper_exists_and_is_executable(self):
        self.assertTrue(os.path.exists(WRAPPER))
        self.assertTrue(os.access(WRAPPER, os.X_OK))

    def test_the_wrapper_has_the_operational_guards(self):
        with open(WRAPPER) as fh:
            text = fh.read()
        for needle in ("flock", "timeout", "--retries", "log_line", "--trading-day-only"):
            self.assertIn(needle, text, "the wrapper is missing %r" % needle)

    def test_the_jobs_use_the_skill_scripts(self):
        text = registry_text()
        for script in ("eod_fetch.py", "daily_bias.py", "run_gex.py", "live_fetch.sh"):
            self.assertIn(script, text, "%s is not wired into the registry" % script)


class TestTradingDay(unittest.TestCase):
    def test_a_weekend_is_closed(self):
        saturday = dt.date(2026, 10, 24)
        self.assertFalse(trading_day.is_trading_day(saturday, holidays=set()))

    def test_a_weekday_is_open(self):
        friday = dt.date(2026, 10, 23)
        self.assertTrue(trading_day.is_trading_day(friday, holidays=set()))

    def test_a_holiday_is_closed(self):
        friday = dt.date(2026, 10, 23)
        self.assertFalse(trading_day.is_trading_day(friday, holidays={friday}))

    def test_the_holiday_list_is_parsed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "holidays.json")
            with open(path, "w") as fh:
                json.dump({"CM": [{"tradingDate": "23-Oct-2026"}]}, fh)
            days = trading_day.holiday_dates(path)
            self.assertIn(dt.date(2026, 10, 23), days)


if __name__ == "__main__":
    unittest.main()
