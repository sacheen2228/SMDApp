import sys, time, urllib.request, pandas as pd, numpy as np
sys.path.insert(0, "Kronos")
from model import Kronos, KronosTokenizer, KronosPredictor

t0 = time.time()
tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
model = Kronos.from_pretrained("NeoQuasar/Kronos-small")
print(f"model loaded in {time.time()-t0:.1f}s")

# Fetch NIFTY daily candles from Yahoo
req = urllib.request.Request(
    "https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=6mo&interval=1d",
    headers={"User-Agent": "Mozilla/5.0"})
raw = urllib.request.urlopen(req, timeout=30).read()
import json
r = json.loads(raw)["chart"]["result"][0]
ts = r["timestamp"]
q = r["indicators"]["quote"][0]
df = pd.DataFrame({"open": q["open"], "high": q["high"], "low": q["low"], "close": q["close"], "volume": q["volume"]})
df["timestamps"] = pd.to_datetime(ts, unit="s")
df = df.dropna().reset_index(drop=True)
print(f"candles: {len(df)} last close: {df.close.iloc[-1]:.1f}")

predictor = KronosPredictor(model, tokenizer, max_context=512)
lookback, pred_len = 400, 10
x_df = df.loc[:lookback-1, ["open","high","low","close","volume"]]
x_ts = df.loc[:lookback-1, "timestamps"]
y_ts = pd.Series(pd.date_range(df.timestamps.iloc[-1] + pd.Timedelta(days=1), periods=pred_len, freq="B"))

t1 = time.time()
pred = predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=pred_len, T=1.0, top_p=0.9, sample_count=3)
print(f"forecast in {time.time()-t1:.1f}s")
print(pred[["open","high","low","close"]].round(1).to_string())
actual_last = df.close.iloc[-1]
pred_dir = "UP" if pred.close.mean() > actual_last else "DOWN"
print(f"\nspot={actual_last:.1f} → 10-bar forecast mean={pred.close.mean():.1f} ({pred_dir}) band=[{pred.close.min():.1f}, {pred.close.max():.1f}]")
