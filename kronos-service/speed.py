import sys, time, json, urllib.request, pandas as pd
sys.path.insert(0, "Kronos")
from model import Kronos, KronosTokenizer, KronosPredictor

tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
model_small = Kronos.from_pretrained("NeoQuasar/Kronos-small")
model_mini = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
tok_mini = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-2k")

req = urllib.request.Request("https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=6mo&interval=1d", headers={"User-Agent": "Mozilla/5.0"})
r = json.loads(urllib.request.urlopen(req, timeout=30).read())["chart"]["result"][0]
q = r["indicators"]["quote"][0]
df = pd.DataFrame({"open": q["open"], "high": q["high"], "low": q["low"], "close": q["close"], "volume": q["volume"]})
df["timestamps"] = pd.to_datetime(r["timestamp"], unit="s")
df = df.dropna().reset_index(drop=True)
x_df = df.loc[:399, ["open","high","low","close","volume"]]
x_ts = df.loc[:399, "timestamps"]
y_ts = pd.Series(pd.date_range(df.timestamps.iloc[-1] + pd.Timedelta(days=1), periods=10, freq="B"))

for name, m, t, ctx in [("small s=1", model_small, tokenizer, 512), ("mini s=1", model_mini, tok_mini, 2048)]:
    p = KronosPredictor(m, t, max_context=ctx)
    t0 = time.time()
    p.predict(df=x_df, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=10, T=1.0, top_p=0.9, sample_count=1)
    print(f"{name}: {time.time()-t0:.1f}s")
