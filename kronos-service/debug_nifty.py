import sys, json, urllib.request, pandas as pd, traceback
sys.path.insert(0, "Kronos")
from model import Kronos, KronosTokenizer, KronosPredictor

tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-2k")
model = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
predictor = KronosPredictor(model, tokenizer, max_context=2048)

req = urllib.request.Request("https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=6mo&interval=1d", headers={"User-Agent": "Mozilla/5.0"})
r = json.loads(urllib.request.urlopen(req, timeout=30).read())["chart"]["result"][0]
q = r["indicators"]["quote"][0]
df = pd.DataFrame({"open": q["open"], "high": q["high"], "low": q["low"], "close": q["close"], "volume": [v or 0 for v in q["volume"]]})
df["timestamps"] = pd.to_datetime(r["timestamp"], unit="s", utc=True).tz_localize(None)
print("raw rows:", len(df), "nan closes:", df.close.isna().sum())
df = df.dropna().reset_index(drop=True)
print("clean rows:", len(df))

lookback = min(400, len(df))
x_df = df.iloc[-lookback:][["open","high","low","close","volume"]].reset_index(drop=True)
x_ts = pd.Series(df["timestamps"].iloc[-lookback:].values)
y_ts = pd.Series(pd.date_range(df["timestamps"].iloc[-1] + pd.Timedelta(minutes=1), periods=10, freq="B"))
print("x_df:", len(x_df), "x_ts:", len(x_ts), "y_ts:", len(y_ts))
try:
    pred = predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=10, T=1.0, top_p=0.9, sample_count=1)
    print("OK\n", pred[["open","close"]].round(1).to_string())
except Exception:
    traceback.print_exc()
    # try smoke-style: end + days(1)
    y2 = pd.Series(pd.date_range(df["timestamps"].iloc[-1] + pd.Timedelta(days=1), periods=10, freq="B"))
    try:
        pred = predictor.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y2, pred_len=10, T=1.0, top_p=0.9, sample_count=1)
        print("OK with days(1) y_ts")
    except Exception:
        traceback.print_exc()
