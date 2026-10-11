# ─── Kronos Forecast Sidecar ──────────────────────────────────────
# Port 8770. Loads Kronos-mini once at startup, serves OHLCV price
# path forecasts for Indian indices (Yahoo candles in, forecast out).
# Decision-support only — NOT investment advice.

import sys
import json
import time
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

import pandas as pd
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

sys.path.insert(0, "Kronos")
from model import Kronos, KronosTokenizer, KronosPredictor  # noqa: E402

# ── Config ────────────────────────────────────────────────────────
YAHOO_SYMBOLS = {
    "NIFTY": "^NSEI",
    "BANKNIFTY": "^NSEBANK",
    "FINNIFTY": "^NSEI",       # Yahoo has no FINNIFTY — NIFTY proxy
    "MIDCPNIFTY": "^NSEI",     # same
    "SENSEX": "^BSESN",
    "BANKEX": "^BSESN",
}
RANGES = {"1d": ("6mo", "1d"), "1h": ("1mo", "1h"), "15m": ("5d", "15m"), "5m": ("5d", "5m")}
CACHE_TTL = {"1d": 6 * 3600, "1h": 1800, "15m": 900, "5m": 900}

app = FastAPI(title="Kronos Forecast Service")
_cache: dict[str, dict[str, Any]] = {}
_ready = False
_predictor: KronosPredictor | None = None
_lock = threading.Lock()  # predictor is not thread-safe — serialize all predicts


def load_model() -> None:
    global _predictor, _ready
    t0 = time.time()
    tokenizer = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-2k")
    model = Kronos.from_pretrained("NeoQuasar/Kronos-mini")
    _predictor = KronosPredictor(model, tokenizer, max_context=2048)
    _ready = True
    print(f"[kronos] model loaded in {time.time() - t0:.1f}s", flush=True)


def fetch_candles(yahoo_symbol: str, interval: str) -> pd.DataFrame:
    rng, iv = RANGES.get(interval, RANGES["1d"])
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_symbol)}?range={rng}&interval={iv}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    raw = urllib.request.urlopen(req, timeout=30).read()
    r = json.loads(raw)["chart"]["result"][0]
    q = r["indicators"]["quote"][0]
    df = pd.DataFrame({
        "open": q["open"], "high": q["high"], "low": q["low"],
        "close": q["close"], "volume": [v or 0 for v in q["volume"]],
    })
    df["timestamps"] = pd.to_datetime(r["timestamp"], unit="s", utc=True).tz_localize(None)
    df = df.dropna().reset_index(drop=True)
    return df


def run_forecast(symbol: str, interval: str, pred_len: int, sample_count: int) -> dict[str, Any]:
    yahoo = YAHOO_SYMBOLS.get(symbol, symbol)
    df = fetch_candles(yahoo, interval)
    if len(df) < 60:
        raise ValueError(f"only {len(df)} candles for {symbol}")

    lookback = min(400, len(df))
    x_df = df.iloc[-lookback:][["open", "high", "low", "close", "volume"]].reset_index(drop=True)
    x_ts = x_df["timestamps"] if "timestamps" in x_df else pd.Series(df["timestamps"].iloc[-lookback:].values)
    # predictor wants open/high/low/close/(volume) only in df — timestamps separate
    x_df = x_df[["open", "high", "low", "close", "volume"]]

    freq = {"1d": "B", "1h": "h", "15m": "15min", "5m": "5min"}.get(interval, "B")
    last_ts = df["timestamps"].iloc[-1]
    y_ts = pd.Series(pd.date_range(last_ts + pd.Timedelta(minutes=1), periods=pred_len, freq=freq))

    t0 = time.time()
    assert _predictor is not None
    with _lock:
        paths = _predictor.predict(
            df=x_df, x_timestamp=pd.Series(df["timestamps"].iloc[-lookback:].values),
            y_timestamp=y_ts, pred_len=pred_len, T=1.0, top_p=0.9,
            sample_count=sample_count,
        )
    elapsed = time.time() - t0

    # paths may be a single df (sample_count=1) or list — normalize
    if isinstance(paths, list):
        closes = pd.concat([p["close"].reset_index(drop=True) for p in paths], axis=1)
        mean_close = closes.mean(axis=1)
        band_lo = closes.min(axis=1)
        band_hi = closes.max(axis=1)
        first = paths[0]
    else:
        mean_close = paths["close"].reset_index(drop=True)
        band_lo, band_hi = mean_close, mean_close
        first = paths

    spot = float(df["close"].iloc[-1])
    target = float(mean_close.iloc[-1])
    direction = "UP" if target > spot else "DOWN" if target < spot else "FLAT"

    # confidence: fraction of sampled paths ending above spot (for UP)
    if isinstance(paths, list) and len(paths) > 1:
        ups = sum(1 for p in paths if float(p["close"].iloc[-1]) > spot)
        conf = (ups / len(paths)) * 100 if direction == "UP" else ((len(paths) - ups) / len(paths)) * 100
    else:
        move_pct = abs(target - spot) / spot * 100 if spot else 0
        conf = min(75.0, 50.0 + move_pct * 5)

    rows = []
    for i in range(pred_len):
        rows.append({
            "date": str(y_ts.iloc[i])[:16],
            "open": round(float(first["open"].iloc[i]), 1),
            "high": round(float(band_hi.iloc[i]), 1),
            "low": round(float(band_lo.iloc[i]), 1),
            "close": round(float(mean_close.iloc[i]), 1),
        })

    return {
        "symbol": symbol,
        "interval": interval,
        "spot": round(spot, 1),
        "direction": direction,
        "confidence": round(conf, 0),
        "target": round(target, 1),
        "changePct": round((target - spot) / spot * 100, 2) if spot else 0,
        "bandLow": round(float(band_lo.min()), 1),
        "bandHigh": round(float(band_hi.max()), 1),
        "pred": rows,
        "model": "Kronos-mini",
        "sampleCount": sample_count,
        "candles": len(df),
        "forecastMs": round(elapsed * 1000),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "ready": _ready, "service": "kronos", "port": 8770}


@app.get("/forecast")
def forecast(
    symbol: str = Query("NIFTY"),
    interval: str = Query("1d"),
    predLen: int = Query(10, alias="pred_len", ge=1, le=60),
    samples: int = Query(5, ge=1, le=10),
) -> JSONResponse:
    if not _ready:
        return JSONResponse({"success": False, "error": "model loading"}, status_code=503)

    key = f"{symbol}:{interval}:{predLen}:{samples}"
    hit = _cache.get(key)
    if hit and time.time() - hit["ts"] < CACHE_TTL.get(interval, 3600):
        return JSONResponse({"success": True, "cached": True, **hit["data"]})

    try:
        data = run_forecast(symbol.upper(), interval, predLen, samples)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"success": False, "error": str(e)[:300]}, status_code=502)

    _cache[key] = {"ts": time.time(), "data": data}
    return JSONResponse({"success": True, "cached": False, **data})


@app.on_event("startup")
def startup() -> None:
    load_model()

    def warm_all() -> None:
        for s in ("NIFTY", "SENSEX", "BANKNIFTY"):
            try:
                run_forecast(s, "1d", 10, 3)
                print(f"[kronos] warmed {s}", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"[kronos] warm {s} failed: {e}", flush=True)

    threading.Thread(target=warm_all, daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8770, log_level="warning")
