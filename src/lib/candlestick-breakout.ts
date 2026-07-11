// Candlestick Breakout + Fakeout Detection Strategy for Indian F&O
// Ported from Python — combines Dynamic S/R + Fakeout Detection + Pattern Confirmation

// ─── Types ──────────────────────────────────────────────────────
export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date;
}

export interface SRLevel {
  price: number;
  name: string;
  type: string;
}

export interface FakeoutResult {
  valid: boolean;
  score: number;
  checks: string[];
  reason: string;
  type: string;
}

export interface BreakoutSignal {
  type: "BREAKOUT_SIGNAL" | "FAKEOUT_ALERT" | "NO_PATTERN" | "NO_BREAK";
  direction: "bullish" | "bearish";
  pattern?: string;
  level: number;
  levelName: string;
  entryPrice?: number;
  slPrice?: number;
  targetPrice?: number;
  riskReward?: number;
  confidence?: number;
  checks?: string[];
  strike?: number;
  optionType?: string;
  action?: string;
  timestamp: string;
  marketTime?: string;
  giftNiftyBias?: string;
}

export interface StrategyConfig {
  min_break_pct?: number;
  volume_mult?: number;
  wick_body_ratio?: number;
  confirm_candles?: number;
  min_confidence?: number;
  avoid_first_5_min?: boolean;
  low_volume_threshold?: number;
  rr_target?: number;
  sl_buffer?: number;
  patterns?: string[];
}

// ─── India S/R Levels ──────────────────────────────────────────
export class IndiaSRLevels {
  pdh: number | null = null;
  pdl: number | null = null;
  pdc: number | null = null;
  orb_high: number | null = null;
  orb_low: number | null = null;
  vwap: number | null = null;
  pivot: number | null = null;
  r1: number | null = null;
  r2: number | null = null;
  s1: number | null = null;
  s2: number | null = null;
  gift_nifty_bias: "bullish" | "bearish" | "neutral" = "neutral";
  intraday_high: number | null = null;
  intraday_low: number | null = null;

  setPreviousDay(high: number, low: number, close: number) {
    this.pdh = high;
    this.pdl = low;
    this.pdc = close;
    this._calculatePivots();
  }

  setGiftNiftyBias(giftOpen: number, prevClose: number) {
    const gap = ((giftOpen - prevClose) / prevClose) * 100;
    if (gap > 0.3) this.gift_nifty_bias = "bullish";
    else if (gap < -0.3) this.gift_nifty_bias = "bearish";
    else this.gift_nifty_bias = "neutral";
  }

  private _calculatePivots() {
    if (this.pdh !== null && this.pdl !== null && this.pdc !== null) {
      this.pivot = (this.pdh + this.pdl + this.pdc) / 3;
      this.r1 = 2 * this.pivot - this.pdl;
      this.r2 = this.pivot + (this.pdh - this.pdl);
      this.s1 = 2 * this.pivot - this.pdh;
      this.s2 = this.pivot - (this.pdh - this.pdl);
    }
  }

  updateORB(candles: Candle[]) {
    if (candles.length === 0) return;
    this.orb_high = Math.max(...candles.map((c) => c.high));
    this.orb_low = Math.min(...candles.map((c) => c.low));
  }

  updateVWAP(candles: Candle[]) {
    if (candles.length === 0) return;
    let totalPV = 0;
    let totalV = 0;
    for (const c of candles) {
      const tp = (c.high + c.low + c.close) / 3;
      totalPV += tp * c.volume;
      totalV += c.volume;
    }
    this.vwap = totalV > 0 ? totalPV / totalV : null;
  }

  updateIntraday(candle: Candle) {
    if (this.intraday_high === null || candle.high > this.intraday_high) {
      this.intraday_high = candle.high;
    }
    if (this.intraday_low === null || candle.low < this.intraday_low) {
      this.intraday_low = candle.low;
    }
  }

  getAllLevels(): SRLevel[] {
    const levels: SRLevel[] = [];
    if (this.pdh !== null) levels.push({ price: this.pdh, name: "PDH", type: "major_resistance" });
    if (this.pdl !== null) levels.push({ price: this.pdl, name: "PDL", type: "major_support" });
    if (this.orb_high !== null) levels.push({ price: this.orb_high, name: "ORB_High", type: "session_resistance" });
    if (this.orb_low !== null) levels.push({ price: this.orb_low, name: "ORB_Low", type: "session_support" });
    if (this.pivot !== null) levels.push({ price: this.pivot, name: "Pivot", type: "key_flip" });
    if (this.r1 !== null) levels.push({ price: this.r1, name: "R1", type: "resistance" });
    if (this.s1 !== null) levels.push({ price: this.s1, name: "S1", type: "support" });
    if (this.vwap !== null) levels.push({ price: this.vwap, name: "VWAP", type: "institutional" });
    if (this.intraday_high !== null) levels.push({ price: this.intraday_high, name: "ID_High", type: "resistance" });
    if (this.intraday_low !== null) levels.push({ price: this.intraday_low, name: "ID_Low", type: "support" });
    return levels.sort((a, b) => a.price - b.price);
  }
}

// ─── Fakeout Detector ──────────────────────────────────────────
export class FakeoutDetector {
  min_break_pct: number;
  volume_mult: number;
  wick_body_ratio: number;
  confirmation_candles: number;
  min_confidence: number;
  avoid_first_5_min: boolean;
  low_volume_threshold: number;

  constructor(config: StrategyConfig = {}) {
    this.min_break_pct = config.min_break_pct ?? 0.003;
    this.volume_mult = config.volume_mult ?? 1.5;
    this.wick_body_ratio = config.wick_body_ratio ?? 2.0;
    this.confirmation_candles = config.confirm_candles ?? 2;
    this.min_confidence = config.min_confidence ?? 60;
    this.avoid_first_5_min = config.avoid_first_5_min ?? true;
    this.low_volume_threshold = config.low_volume_threshold ?? 0.7;
  }

  analyze(
    candle: Candle,
    level: number,
    levelType: string,
    sr: IndiaSRLevels,
    recentCandles: Candle[]
  ): FakeoutResult {
    let score = 0;
    const checks: string[] = [];

    // CHECK 1: Time-based (India specific)
    const h = candle.timestamp.getHours();
    const m = candle.timestamp.getMinutes();
    const totalMin = h * 60 + m;

    // Avoid 9:15-9:20 (first 5 min = fakeout zone)
    if (this.avoid_first_5_min && totalMin >= 555 && totalMin <= 560) {
      return { valid: false, score: 0, checks: [], reason: "First 5 min - fakeout zone", type: "TIME_FILTER" };
    }

    // 11:00-12:30 low volume period
    if (totalMin >= 660 && totalMin <= 750) {
      score -= 10;
      checks.push("Low volume period (-10)");
    }

    // 14:30-15:15 institutional window
    if (totalMin >= 870 && totalMin <= 915) {
      score += 15;
      checks.push("Institutional window (+15)");
    }

    // CHECK 2: Break magnitude
    const isResistance = levelType.includes("resistance") || levelType.includes("res");
    const isSupport = levelType.includes("support") || levelType.includes("supp");

    if (isResistance) {
      const breakPct = (candle.close - level) / level;
      const wickPct = (candle.high - level) / level;

      if (breakPct < this.min_break_pct) {
        if (wickPct > this.min_break_pct) {
          return {
            valid: false, score: 10, checks: [],
            reason: `Wick break ${(wickPct * 100).toFixed(2)}% but close only ${(breakPct * 100).toFixed(2)}% - FAKEOUT`,
            type: "WICK_FAKEOUT",
          };
        }
        return {
          valid: false, score: 0, checks: [],
          reason: `Close ${(breakPct * 100).toFixed(2)}% < min ${(this.min_break_pct * 100).toFixed(2)}%`,
          type: "NO_BREAK",
        };
      }
      score += 20;
      checks.push(`Close break ${(breakPct * 100).toFixed(2)}% (+20)`);
      if (breakPct > this.min_break_pct * 2) {
        score += 10;
        checks.push("Strong break (+10)");
      }
    } else if (isSupport) {
      const breakPct = (level - candle.close) / level;
      const wickPct = (level - candle.low) / level;

      if (breakPct < this.min_break_pct) {
        if (wickPct > this.min_break_pct) {
          return {
            valid: false, score: 10, checks: [],
            reason: `Wick break ${(wickPct * 100).toFixed(2)}% but close only ${(breakPct * 100).toFixed(2)}% - FAKEOUT`,
            type: "WICK_FAKEOUT",
          };
        }
        return {
          valid: false, score: 0, checks: [],
          reason: `Close ${(breakPct * 100).toFixed(2)}% < min ${(this.min_break_pct * 100).toFixed(2)}%`,
          type: "NO_BREAK",
        };
      }
      score += 20;
      checks.push(`Close break ${(breakPct * 100).toFixed(2)}% (+20)`);
      if (breakPct > this.min_break_pct * 2) {
        score += 10;
        checks.push("Strong break (+10)");
      }
    }

    // CHECK 3: Volume Confirmation
    const recent20 = recentCandles.slice(-20);
    const avgVolume = recent20.length > 0
      ? recent20.reduce((s, c) => s + c.volume, 0) / recent20.length
      : candle.volume;
    const volRatio = avgVolume > 0 ? candle.volume / avgVolume : 1;

    if (volRatio < this.low_volume_threshold) {
      score -= 15;
      checks.push(`Low volume ${volRatio.toFixed(1)}x (-15)`);
    } else if (volRatio >= this.volume_mult) {
      score += 20;
      checks.push(`High volume ${volRatio.toFixed(1)}x (+20)`);
    } else if (volRatio >= 1.0) {
      score += 10;
      checks.push(`Normal volume ${volRatio.toFixed(1)}x (+10)`);
    } else {
      score -= 5;
      checks.push(`Weak volume ${volRatio.toFixed(1)}x (-5)`);
    }

    // CHECK 4: Wick Analysis
    const body = Math.abs(candle.close - candle.open);
    const totalRange = candle.high - candle.low;

    if (totalRange > 0) {
      const bodyRatio = body / totalRange;
      if (bodyRatio < 0.3) {
        score -= 15;
        checks.push(`Doji-like ${(bodyRatio * 100).toFixed(0)}% body (-15)`);
      } else if (bodyRatio > 0.6) {
        score += 10;
        checks.push(`Strong body ${(bodyRatio * 100).toFixed(0)}% (+10)`);
      }

      if (isResistance) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        if (upperWick > body * this.wick_body_ratio) {
          score -= 10;
          checks.push("Long upper wick (-10)");
        }
      } else if (isSupport) {
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        if (lowerWick > body * this.wick_body_ratio) {
          score -= 10;
          checks.push("Long lower wick (-10)");
        }
      }
    }

    // CHECK 5: Multi-Candle Confirmation
    if (recentCandles.length >= this.confirmation_candles) {
      const confirms = recentCandles.slice(-this.confirmation_candles);
      if (isResistance) {
        const greenCount = confirms.filter((c) => c.close > c.open).length;
        if (greenCount >= this.confirmation_candles) {
          score += 15;
          checks.push(`${this.confirmation_candles} green confirms (+15)`);
        } else if (greenCount === 0) {
          score -= 10;
          checks.push("All red after break (-10)");
        }
      } else if (isSupport) {
        const redCount = confirms.filter((c) => c.close < c.open).length;
        if (redCount >= this.confirmation_candles) {
          score += 15;
          checks.push(`${this.confirmation_candles} red confirms (+15)`);
        } else if (redCount === 0) {
          score -= 10;
          checks.push("All green after break (-10)");
        }
      }
    }

    // CHECK 6: GIFT Nifty Bias
    if (sr.gift_nifty_bias === "bullish" && isResistance) {
      score += 10;
      checks.push("GIFT Nifty bullish align (+10)");
    } else if (sr.gift_nifty_bias === "bearish" && isSupport) {
      score += 10;
      checks.push("GIFT Nifty bearish align (+10)");
    } else if (sr.gift_nifty_bias !== "neutral") {
      score -= 5;
      checks.push("GIFT Nifty against bias (-5)");
    }

    // CHECK 7: Level Strength
    if (levelType.includes("major")) {
      score += 10;
      checks.push("Major level (+10)");
    } else if (levelType.includes("session")) {
      score += 5;
      checks.push("Session level (+5)");
    }

    const isValid = score >= this.min_confidence;
    return {
      valid: isValid,
      score,
      checks,
      reason: checks.length > 0 ? checks.join(" | ") : `Score ${score} < ${this.min_confidence}`,
      type: isValid ? "VALID_BREAKOUT" : "FAKEOUT",
    };
  }
}

// ─── Candlestick Pattern Detector ──────────────────────────────
export class CandlestickPatternDetector {
  static detect(candle: Candle, prevCandle: Candle, direction: string): string | null {
    const body = Math.abs(candle.close - candle.open);
    const prevBody = Math.abs(prevCandle.close - prevCandle.open);
    const totalRange = candle.high - candle.low;
    const prevRange = prevCandle.high - prevCandle.low;

    if (direction === "bullish") {
      // Bullish Engulfing
      if (
        candle.close > candle.open &&
        prevCandle.close < prevCandle.open &&
        candle.open < prevCandle.close &&
        candle.close > prevCandle.open
      ) {
        return "bullish_engulfing";
      }

      // Hammer
      const lowerWick = Math.min(candle.close, candle.open) - candle.low;
      const upperWick = candle.high - Math.max(candle.close, candle.open);
      if (candle.close > candle.open && lowerWick > body * 2 && upperWick < body * 0.5 && body > 0) {
        return "hammer";
      }

      // Bullish Pin Bar
      if (body > 0 && totalRange > 0) {
        const lw = Math.min(candle.close, candle.open) - candle.low;
        if (lw / totalRange > 0.6 && body / totalRange < 0.3) {
          return "bullish_pin_bar";
        }
      }

      // Morning Star (simplified)
      if (prevBody > 0 && prevRange > 0) {
        if (
          prevCandle.close < prevCandle.open &&
          Math.abs(candle.open - prevCandle.close) / prevRange < 0.3 &&
          candle.close > candle.open
        ) {
          return "morning_star";
        }
      }
    } else if (direction === "bearish") {
      // Bearish Engulfing
      if (
        candle.close < candle.open &&
        prevCandle.close > prevCandle.open &&
        candle.open > prevCandle.close &&
        candle.close < prevCandle.open
      ) {
        return "bearish_engulfing";
      }

      // Shooting Star
      const upperWick = candle.high - Math.max(candle.close, candle.open);
      const lowerWick = Math.min(candle.close, candle.open) - candle.low;
      if (candle.close < candle.open && upperWick > body * 2 && lowerWick < body * 0.5 && body > 0) {
        return "shooting_star";
      }

      // Bearish Pin Bar
      if (body > 0 && totalRange > 0) {
        const uw = candle.high - Math.max(candle.close, candle.open);
        if (uw / totalRange > 0.6 && body / totalRange < 0.3) {
          return "bearish_pin_bar";
        }
      }

      // Evening Star (simplified)
      if (prevBody > 0 && prevRange > 0) {
        if (
          prevCandle.close > prevCandle.open &&
          Math.abs(candle.open - prevCandle.close) / prevRange < 0.3 &&
          candle.close < candle.open
        ) {
          return "evening_star";
        }
      }
    }

    return null;
  }
}

// ─── Main Strategy Engine ──────────────────────────────────────
export class CandlestickBreakoutIndia {
  sr: IndiaSRLevels;
  fakeout: FakeoutDetector;
  patterns: string[];
  rrTarget: number;
  slBuffer: number;
  candles: Candle[] = [];
  orbCandles: Candle[] = [];

  constructor(config: StrategyConfig = {}) {
    this.sr = new IndiaSRLevels();
    this.fakeout = new FakeoutDetector(config);
    this.patterns = config.patterns ?? [
      "bullish_engulfing", "bearish_engulfing",
      "hammer", "shooting_star",
      "bullish_pin_bar", "bearish_pin_bar",
    ];
    this.rrTarget = config.rr_target ?? 1.5;
    this.slBuffer = config.sl_buffer ?? 0.002;
  }

  onTick(tick: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    timestamp: string;
  }): BreakoutSignal | null {
    const candle: Candle = {
      open: tick.open,
      high: tick.high,
      low: tick.low,
      close: tick.close,
      volume: tick.volume,
      timestamp: new Date(tick.timestamp),
    };

    this.candles.push(candle);
    if (this.candles.length > 100) this.candles = this.candles.slice(-100);

    // Update levels
    this.sr.updateIntraday(candle);

    const h = candle.timestamp.getHours();
    const m = candle.timestamp.getMinutes();
    const totalMin = h * 60 + m;

    // Capture ORB candles (9:15-9:30)
    if (totalMin >= 555 && totalMin <= 570) {
      this.orbCandles.push(candle);
      if (totalMin >= 570 && this.sr.orb_high === null) {
        this.sr.updateORB(this.orbCandles);
      }
    }

    this.sr.updateVWAP(this.candles);

    if (this.candles.length < 5) return null;

    const levels = this.sr.getAllLevels();
    if (levels.length === 0) return null;

    const current = this.candles[this.candles.length - 1];
    const previous = this.candles[this.candles.length - 2];

    for (const { price: levelPrice, name: levelName, type: levelType } of levels) {
      if (Math.abs(current.close - levelPrice) / levelPrice < 0.001) continue;

      const isBreakingResistance = previous.close <= levelPrice && current.close > levelPrice;
      const isBreakingSupport = previous.close >= levelPrice && current.close < levelPrice;

      if (!isBreakingResistance && !isBreakingSupport) continue;

      const direction = isBreakingResistance ? "bullish" : "bearish";

      // Fakeout detection
      const fakeoutCheck = this.fakeout.analyze(current, levelPrice, levelType, this.sr, this.candles);

      if (!fakeoutCheck.valid) {
        return {
          type: "FAKEOUT_ALERT",
          direction,
          level: levelPrice,
          levelName,
          score: fakeoutCheck.score,
          reason: fakeoutCheck.reason,
          timestamp: current.timestamp.toISOString(),
        };
      }

      // Pattern check
      const pattern = CandlestickPatternDetector.detect(current, previous, direction);

      if (!this.patterns.includes(pattern || "")) {
        return {
          type: "NO_PATTERN",
          direction,
          level: levelPrice,
          levelName,
          score: fakeoutCheck.score,
          reason: `Valid break but no pattern (${pattern || "none"})`,
          timestamp: current.timestamp.toISOString(),
        };
      }

      // VALID SIGNAL
      const entryPrice = current.close;
      const slPrice = this._calculateSL(direction, levelPrice, current);
      const targetPrice = this._calculateTarget(entryPrice, slPrice, direction);
      const riskReward = Math.abs(targetPrice - entryPrice) / Math.abs(entryPrice - slPrice);
      const strike = Math.round(levelPrice / 50) * 50;

      return {
        type: "BREAKOUT_SIGNAL",
        direction,
        pattern: pattern || undefined,
        level: levelPrice,
        levelName,
        entryPrice,
        slPrice,
        targetPrice,
        riskReward: Math.round(riskReward * 100) / 100,
        confidence: fakeoutCheck.score,
        checks: fakeoutCheck.checks,
        strike,
        optionType: "CE",
        action: direction === "bullish" ? "BUY_CE" : "BUY_PE",
        timestamp: current.timestamp.toISOString(),
        marketTime: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        giftNiftyBias: this.sr.gift_nifty_bias,
      };
    }

    return null;
  }

  private _calculateSL(direction: string, level: number, candle: Candle): number {
    if (direction === "bullish") {
      return Math.min(level * (1 - this.slBuffer), candle.low * 0.998);
    }
    return Math.max(level * (1 + this.slBuffer), candle.high * 1.002);
  }

  private _calculateTarget(entry: number, sl: number, direction: string): number {
    const risk = Math.abs(entry - sl);
    if (direction === "bullish") return entry + risk * this.rrTarget;
    return entry - risk * this.rrTarget;
  }

  // Simulate candles from option chain data for demo
  async simulateFromMarketData(spotPrice: number, vix: number, symbol?: string): Promise<BreakoutSignal | null> {
    const now = new Date();
    const volatility = vix / 100;

    // Try to fetch real intraday candles from Breeze
    let candles: Array<{open: number; high: number; low: number; close: number; volume: number; timestamp: string}> = [];
    if (symbol) {
      try {
        const { getIntradayCandles } = await import("@/lib/breeze-historical");
        const rawCandles = await getIntradayCandles(symbol, "5minute", "");
        candles = rawCandles.map(c => ({
          open: c.open, high: c.high, low: c.low, close: c.close,
          volume: c.volume, timestamp: c.time,
        }));
      } catch {
        // Fall through to simulation
      }
    }

    if (candles.length > 0) {
      // Use real candles — derive previous day levels from real data
      const recentCloses = candles.slice(-20).map(c => c.close);
      const pdh = Math.max(...candles.slice(-50).map(c => c.high));
      const pdl = Math.min(...candles.slice(-50).map(c => c.low));
      const pdc = recentCloses[recentCloses.length - 1] || spotPrice;
      this.sr.setPreviousDay(pdh, pdl, pdc);
      this.sr.setGiftNiftyBias(spotPrice * (1 + (Math.random() - 0.48) * 0.005), pdc);

      // Feed real candles
      for (const candle of candles.slice(-20)) {
        this.onTick(candle);
      }

      // Feed the latest candle as a potential breakout
      const lastCandle = candles[candles.length - 1];
      return this.onTick(lastCandle);
    }

    // Fallback: simulated candles (no real data available)
    // Generate simulated previous day levels
    const pdh = spotPrice * (1 + volatility * 0.5);
    const pdl = spotPrice * (1 - volatility * 0.5);
    const pdc = spotPrice * (1 + (Math.random() - 0.5) * volatility * 0.3);
    this.sr.setPreviousDay(pdh, pdl, pdc);

    // Set GIFT Nifty bias
    this.sr.setGiftNiftyBias(spotPrice * (1 + (Math.random() - 0.48) * 0.005), pdc);

    // Generate 20 simulated candles
    for (let i = 0; i < 20; i++) {
      const ts = new Date(now.getTime() - (20 - i) * 5 * 60000);
      ts.setHours(9, 30 + i * 5, 0, 0);

      const basePrice = spotPrice * (1 + (Math.random() - 0.5) * volatility * 0.02);
      const open = basePrice;
      const close = basePrice * (1 + (Math.random() - 0.48) * volatility * 0.01);
      const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.005);
      const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.005);
      const volume = 500000 + Math.random() * 2000000;

      this.onTick({
        open, high, low, close, volume,
        timestamp: ts.toISOString(),
      });
    }

    // Now simulate a breakout candle
    const breakoutCandle = {
      open: spotPrice * 0.999,
      high: spotPrice * 1.008,
      low: spotPrice * 0.997,
      close: spotPrice * 1.005,
      volume: 3000000,
      timestamp: (() => {
        const ts = new Date(now);
        ts.setHours(10, 30, 0, 0);
        return ts.toISOString();
      })(),
    };

    return this.onTick(breakoutCandle);
  }
}
