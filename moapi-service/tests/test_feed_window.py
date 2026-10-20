#!/usr/bin/env python3
"""The broadcast feed must only run inside the session window."""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Patch FEED_WINDOW before importing service so tests control the window
import moapi.config as _cfg
_original_fe = _cfg.FEED_WINDOW

from moapi.service import MoapiService

class TestFeedWindow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Override the window for all tests — default 09:15-15:30
        os.environ["MOAPI_FEED_HOURS"] = "09:15-15:30"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("MOAPI_FEED_HOURS", None)

    def test_inside_the_session_the_feed_runs(self):
        # 11:00 IST on a weekday is inside 09:15-15:30
        now = datetime.datetime(2026, 10, 21, 11, 0,
                                tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
        self.assertTrue(MoapiService._in_feed_window(now))

    def test_outside_the_session_the_feed_is_off_before(self):
        # 09:00 IST on a weekday is before 09:15
        now = datetime.datetime(2026, 10, 21, 9, 0,
                                tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
        self.assertFalse(MoapiService._in_feed_window(now))

    def test_outside_the_session_the_feed_is_off_after(self):
        # 15:45 IST on a weekday is after 15:30
        now = datetime.datetime(2026, 10, 21, 15, 45,
                                tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
        self.assertFalse(MoapiService._in_feed_window(now))

    def test_outside_the_session_the_feed_is_off_evening(self):
        # 18:00 IST on a weekday is after hours
        now = datetime.datetime(2026, 10, 21, 18, 0,
                                tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
        self.assertFalse(MoapiService._in_feed_window(now))

    def test_weekends_are_off(self):
        # 2026-10-25 is a Sunday; weekday() returns 6
        now = datetime.datetime(2026, 10, 25, 11, 0,
                                tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
        self.assertFalse(MoapiService._in_feed_window(now))

    def test_malformed_window_fails_open(self):
        # A window that can't be parsed should leave the feed enabled (True)
        os.environ["MOAPI_FEED_HOURS"] = "broken"
        try:
            now = datetime.datetime(2026, 10, 21, 11, 0,
                                    tzinfo=datetime.timezone(datetime.timedelta(hours=5, minutes=30)))
            # If parsing fails, _in_feed_window returns True (fail-open)
            self.assertTrue(MoapiService._in_feed_window(now))
        finally:
            os.environ.pop("MOAPI_FEED_HOURS", None)


if __name__ == "__main__":
    unittest.main()
