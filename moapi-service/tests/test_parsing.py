"""Parsing of the captured MO payloads — the instrument master, LTP and feed.

Offline: every payload is a captured sample, nothing calls Motilal.
"""

import unittest

from _support import (
    MO_FUTURE_ROW,
    MO_FEED_DEPTH_PACKET,
    MO_FEED_LTP_PACKET,
    MO_FEED_OI_PACKET,
    MO_INSTRUMENT_ROW,
    MO_LTP_NO_RECORDS,
    MO_LTP_RESPONSE,
    MO_SBIN_OPTION_ROW,
)

from moapi import instruments
from moapi.feed import FeedCache
from moapi.service import scale_for_price


class TestInstrumentMasterParsing(unittest.TestCase):
    def test_option_row_is_parsed(self):
        contract = instruments.normalise_row(MO_INSTRUMENT_ROW)
        self.assertEqual(contract["symbol"], "NIFTY")
        self.assertEqual(contract["exchange"], "NSEFO")
        self.assertEqual(contract["instrumentType"], "OPTIDX")
        self.assertEqual(contract["optionType"], "CE")
        self.assertEqual(contract["strike"], 22000.0)
        self.assertEqual(contract["lotSize"], 65)
        self.assertEqual(contract["scripcode"], 51308)

    def test_expiry_comes_from_the_name_not_the_epoch(self):
        # MO's expirydate is ten years in the past; scripname has the truth.
        contract = instruments.normalise_row(MO_INSTRUMENT_ROW)
        self.assertEqual(contract["expiry"], "2026-10-27")
        self.assertNotEqual(contract["expiry"], "2016-10-27")

    def test_tradingsymbol_is_the_nse_convention(self):
        contract = instruments.normalise_row(MO_INSTRUMENT_ROW)
        self.assertEqual(contract["tradingsymbol"], "NIFTY26OCT202622000CE")

    def test_future_row_has_no_option_fields(self):
        contract = instruments.normalise_row(MO_FUTURE_ROW)
        self.assertEqual(contract["instrumentType"], "FUTIDX")
        self.assertIsNone(contract["optionType"])
        self.assertIsNone(contract["strike"])
        self.assertEqual(contract["expiry"], "2026-10-27")
        self.assertEqual(contract["tradingsymbol"], "NIFTY26OCT2026FUT")

    def test_lot_sizes_come_from_the_fno_rows(self):
        contracts = [
            instruments.normalise_row(MO_INSTRUMENT_ROW),
            instruments.normalise_row(MO_SBIN_OPTION_ROW),
            # The cash master reports marketlot 1 for every equity — it must
            # never win over the F&O lot.
            dict(MO_SBIN_OPTION_ROW, exchangename="NSE", instrumentname="EQ",
                 optiontype="EQ", scripname="SBIN EQ"),
        ]
        lots = instruments.lot_sizes_from_contracts(contracts)
        self.assertEqual(lots["NIFTY"], 65)
        self.assertEqual(lots["SBIN"], 750)

    def test_parse_master_accepts_a_raw_response(self):
        payload = {"status": "SUCCESS", "data": [MO_INSTRUMENT_ROW, MO_SBIN_OPTION_ROW]}
        parsed = instruments.parse_master(payload)
        self.assertEqual(len(parsed), 2)
        self.assertEqual(parsed[0]["lotSize"], 65)
        self.assertEqual(parsed[1]["lotSize"], 750)

    def test_parse_master_rejects_a_failed_response(self):
        self.assertEqual(instruments.parse_master({"status": "ERROR", "data": []}), [])

    def test_tradingsymbol_round_trip(self):
        parsed = instruments.parse_tradingsymbol("NIFTY26OCT202622000CE")
        self.assertEqual(parsed["symbol"], "NIFTY")
        self.assertEqual(parsed["strike"], 22000.0)
        self.assertEqual(parsed["optionType"], "CE")


class TestLtpParsing(unittest.TestCase):
    def test_rest_prices_are_paise(self):
        contract = instruments.normalise_row(MO_INSTRUMENT_ROW)
        price, scale, verified = scale_for_price(MO_LTP_RESPONSE["data"]["ltp"], contract)
        self.assertEqual(scale, 100)
        self.assertTrue(verified)
        self.assertAlmostEqual(price, 898.90, places=2)

    def test_rest_response_shape(self):
        self.assertEqual(MO_LTP_RESPONSE["status"], "SUCCESS")
        data = MO_LTP_RESPONSE["data"]
        self.assertEqual(data["scripcode"], 51308)
        self.assertEqual(data["volume"], 365040)
        self.assertIn("ltp", data)

    def test_no_records_response_is_an_error(self):
        self.assertEqual(MO_LTP_NO_RECORDS["status"], "ERROR")
        self.assertIn("NO RECORDS", MO_LTP_NO_RECORDS["message"])


class TestFeedPacketParsing(unittest.TestCase):
    def setUp(self):
        self.cache = FeedCache()

    def test_ltp_packet_is_cached_in_rupees_with_oi(self):
        self.cache.record("LTP", MO_FEED_LTP_PACKET)
        quote = self.cache.quote(51308)
        self.assertAlmostEqual(quote["ltp"], 898.9, places=2)
        self.assertEqual(quote["oi"], 154320)
        self.assertEqual(quote["exchangeTime"], "15:20:31")

    def test_oi_packet_updates_the_quote(self):
        self.cache.record("LTP", MO_FEED_LTP_PACKET)
        self.cache.record("OpenInterest", MO_FEED_OI_PACKET)
        quote = self.cache.quote(51308)
        self.assertEqual(quote["oi"], 154320)
        self.assertEqual(quote["oiHigh"], 160000)

    def test_oi_change_is_the_delta_to_the_previous_value(self):
        self.cache.record("LTP", MO_FEED_LTP_PACKET)          # oi = 154320
        second = dict(MO_FEED_LTP_PACKET, **{"LTP_Open Interest": 154900})
        self.cache.record("LTP", second)                     # oi = 154900
        quote = self.cache.quote(51308)
        self.assertEqual(quote["oi"], 154900)
        self.assertEqual(quote["prevOi"], 154320)

    def test_depth_packet_is_cached_per_level(self):
        self.cache.record("MarketDepth", MO_FEED_DEPTH_PACKET)
        levels = self.cache.depth(51308)
        self.assertIn("1", levels)
        self.assertAlmostEqual(levels["1"]["bid"], 898.85, places=2)
        self.assertEqual(levels["1"]["bidQty"], 250)
        self.assertAlmostEqual(levels["1"]["ask"], 899.1, places=2)
        self.assertEqual(levels["1"]["askQty"], 180)


if __name__ == "__main__":
    unittest.main()
