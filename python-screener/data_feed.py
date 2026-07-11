"""
data_feed.py
Thin wrapper around ICICI Breeze Connect for the data this screener needs.

Install: pip install breeze-connect --break-system-packages

Docs (verify against current API since Breeze changes fields periodically):
https://api.icicidirect.com/apiuser/home
"""

from breeze_connect import BreezeConnect
import pandas as pd
from datetime import datetime


class BreezeDataFeed:
    def __init__(self, api_key: str, api_secret: str, session_token: str):
        self.breeze = BreezeConnect(api_key=api_key)
        self.breeze.generate_session(api_secret=api_secret, session_token=session_token)

    # ---------- OHLC ----------
    def get_ohlc(self, stock_code: str, interval: str, from_date: str, to_date: str,
                  exchange_code: str = "NSE", product_type: str = "cash") -> pd.DataFrame:
        """
        interval: '1minute', '5minute', '30minute', '1day' (check current Breeze docs for exact strings)
        from_date/to_date: 'YYYY-MM-DDTHH:MM:SS.000Z'
        Returns a DataFrame with columns: datetime, open, high, low, close, volume
        """
        resp = self.breeze.get_historical_data_v2(
            interval=interval,
            from_date=from_date,
            to_date=to_date,
            stock_code=stock_code,
            exchange_code=exchange_code,
            product_type=product_type,
        )
        if resp.get("Status") != 200 or not resp.get("Success"):
            raise RuntimeError(f"Breeze OHLC fetch failed: {resp}")

        df = pd.DataFrame(resp["Success"])
        if df.empty:
            return df
        df["datetime"] = pd.to_datetime(df["datetime"])
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.sort_values("datetime").reset_index(drop=True)
        return df

    # ---------- Option chain ----------
    def get_option_chain(self, stock_code: str, expiry_date: str,
                          exchange_code: str = "NFO", product_type: str = "options") -> pd.DataFrame:
        """
        expiry_date format: 'YYYY-MM-DD'
        Returns raw option chain as DataFrame (strike, right, OI, volume, ltp, etc.)
        Field names depend on Breeze's current response schema — inspect resp once live
        and adjust column names in indicators.py if they differ.
        """
        resp = self.breeze.get_option_chain_quotes(
            stock_code=stock_code,
            exchange_code=exchange_code,
            product_type=product_type,
            expiry_date=expiry_date,
            right="others",
            strike_price="0",
        )
        if resp.get("Status") != 200 or not resp.get("Success"):
            raise RuntimeError(f"Breeze option chain fetch failed: {resp}")
        return pd.DataFrame(resp["Success"])

    # ---------- India VIX ----------
    def get_india_vix(self) -> float:
        resp = self.breeze.get_quotes(stock_code="INDVIX", exchange_code="NSE")
        if resp.get("Status") != 200 or not resp.get("Success"):
            raise RuntimeError(f"Breeze VIX fetch failed: {resp}")
        return float(resp["Success"][0]["ltp"])
