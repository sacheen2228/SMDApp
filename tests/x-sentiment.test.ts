import { describe, it, expect } from "bun:test";
import { parseXItems, aggregateTweets, fetchXBuzz, clearXCache } from "../src/lib/x-sentiment";
import type { XTweet } from "../src/lib/x-sentiment";

// ─── FIXTURES ─────────────────────────────────────────────────────

// Google News RSS shape for site:x.com queries: real tweet-text items mixed
// with author-profile items ("Name (@handle) - x.com") which are noise.
// Fresh items use RELATIVE dates — fixed dates age past the 3-day cutoff
// and break the suite over time (time-bomb).
const NOW = Date.now();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toUTCString();
const FIXTURE_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>site:x.com (Nifty) - Google News</title>
<item>
  <title>Nifty breakout confirmed with strong volume, bank nifty rallying hard, this bull run targets 25000 next</title>
  <link>https://news.google.com/rss/articles/CBMiTweet1</link>
  <pubDate>${hoursAgo(6)}</pubDate>
  <description><a href="https://news.google.com/rss/articles/CBMiTweet1">Nifty breakout</a></description>
</item>
<item>
  <title>Market crash incoming, nifty falling to 21000, sell everything and book losses before disaster hits</title>
  <link>https://news.google.com/rss/articles/CBMiTweet2</link>
  <pubDate>${hoursAgo(5)}</pubDate>
  <description><a href="https://news.google.com/rss/articles/CBMiTweet2">Market crash</a></description>
</item>
<item>
  <title>Rohit Srivastava (@indiacharts) - x.com</title>
  <link>https://news.google.com/rss/articles/CBMiProfile</link>
  <pubDate>Fri, 31 May 2024 20:07:10 GMT</pubDate>
  <description><a href="https://news.google.com/rss/articles/CBMiProfile">profile</a></description>
</item>
<item>
  <title>Nifty closed flat today, nothing much happened in the market, waiting for RBI policy next week for direction</title>
  <link>https://news.google.com/rss/articles/CBMiTweet3</link>
  <pubDate>${hoursAgo(4)}</pubDate>
  <description><a href="https://news.google.com/rss/articles/CBMiTweet3">flat</a></description>
</item>
</channel></rss>`;

function makeTweet(overrides: Partial<XTweet> = {}): XTweet {
  return {
    text: "Nifty looks bullish",
    author: null,
    link: "https://x.com/i/status/1",
    publishedAt: new Date().toISOString(),
    score: 0,
    label: "NEUTRAL",
    ...overrides,
  };
}

// ─── parseXItems ──────────────────────────────────────────────────

describe("parseXItems", () => {
  it("extracts tweet-text items from Google News RSS", () => {
    const tweets = parseXItems(FIXTURE_RSS);
    expect(tweets.length).toBe(3); // author-profile item filtered out
    expect(tweets[0].text).toContain("Nifty breakout confirmed");
    expect(tweets[0].link).toContain("CBMiTweet1");
    expect(tweets[0].publishedAt).toBeTruthy();
  });

  it("drops author-profile noise items (Name (@handle) - x.com)", () => {
    const tweets = parseXItems(FIXTURE_RSS);
    const texts = tweets.map((t) => t.text).join(" | ");
    expect(texts).not.toContain("(@indiacharts)");
    expect(texts).not.toContain("- x.com");
  });

  it("scores each tweet with the deterministic sentiment analyzer", () => {
    const tweets = parseXItems(FIXTURE_RSS);
    const bullish = tweets.find((t) => t.text.includes("breakout confirmed"));
    const bearish = tweets.find((t) => t.text.includes("Market crash"));
    expect(bullish!.score).toBeGreaterThan(0);
    expect(bullish!.label).toBe("BULLISH");
    expect(bearish!.score).toBeLessThan(0);
    expect(bearish!.label).toBe("BEARISH");
  });

  it("drops stale items older than maxAgeDays", () => {
    const tweets = parseXItems(FIXTURE_RSS, { maxAgeDays: 1 });
    // fixture dates are Sep 2026 — relative to real clock; if clock is far
    // ahead, everything is stale; if within 1 day, items survive.
    const fixtureNewest = Math.max(
      ...Array.from(FIXTURE_RSS.matchAll(/<pubDate>(.*?)<\/pubDate>/g)).map((m) =>
        new Date(m[1]).getTime()
      )
    );
    const expected = Date.now() - fixtureNewest <= 1 * 86400_000 ? 3 : 0;
    expect(tweets.length).toBe(expected);
  });

  it("returns empty array for garbage input", () => {
    expect(parseXItems("not xml at all")).toEqual([]);
    expect(parseXItems("")).toEqual([]);
  });
});

// ─── aggregateTweets ──────────────────────────────────────────────

describe("aggregateTweets", () => {
  it("aggregates bullish majority into 0-100 score with BULLISH label", () => {
    const buzz = aggregateTweets([
      makeTweet({ text: "bull", score: 0.6, label: "BULLISH" }),
      makeTweet({ text: "bull2", score: 0.4, label: "BULLISH" }),
      makeTweet({ text: "flat", score: 0.0, label: "NEUTRAL" }),
    ]);
    expect(buzz.available).toBe(true);
    expect(buzz.source).toBe("google-news-x");
    expect(buzz.tweetCount).toBe(3);
    expect(buzz.score).toBeGreaterThan(50);
    expect(buzz.label).toBe("BULLISH");
    expect(buzz.avgSentiment).toBeCloseTo((0.6 + 0.4 + 0) / 3, 2);
    expect(buzz.score).toBe(Math.round(((0.6 + 0.4 + 0) / 3 + 1) * 50));
  });

  it("aggregates bearish majority below 50 with BEARISH label", () => {
    const buzz = aggregateTweets([
      makeTweet({ text: "a", score: -0.5, label: "BEARISH" }),
      makeTweet({ text: "b", score: -0.3, label: "BEARISH" }),
    ]);
    expect(buzz.score).toBeLessThan(50);
    expect(buzz.label).toBe("BEARISH");
  });

  it("returns available=false on zero tweets (never fabricate sentiment)", () => {
    const buzz = aggregateTweets([]);
    expect(buzz.available).toBe(false);
    expect(buzz.tweetCount).toBe(0);
    expect(buzz.reason).toBeTruthy();
  });

  it("returns top samples sorted by absolute sentiment strength", () => {
    const buzz = aggregateTweets([
      makeTweet({ text: "weak", score: 0.05 }),
      makeTweet({ text: "strong-bull", score: 0.9 }),
      makeTweet({ text: "strong-bear", score: -0.8 }),
      makeTweet({ text: "mid", score: 0.3 }),
      makeTweet({ text: "mid2", score: -0.4 }),
      makeTweet({ text: "mid3", score: 0.2 }),
    ]);
    expect(buzz.samples.length).toBeLessThanOrEqual(5);
    expect(buzz.samples[0].text).toBe("strong-bull");
    expect(buzz.samples[1].text).toBe("strong-bear");
  });

  it("keeps author when provided", () => {
    const buzz = aggregateTweets([makeTweet({ author: "@indiacharts", score: 0.5, label: "BULLISH" })]);
    expect(buzz.samples[0].author).toBe("@indiacharts");
  });
});

// ─── fetchXBuzz ───────────────────────────────────────────────────

describe("fetchXBuzz", () => {
  it("returns a shaped XBuzz result (available or honest unavailable)", async () => {
    clearXCache();
    const buzz = await fetchXBuzz();
    // Network may fail in CI — shape is what matters, never fabricated fields
    expect(typeof buzz.available).toBe("boolean");
    expect(buzz.source).toBe("google-news-x");
    if (buzz.available) {
      expect(buzz.tweetCount).toBeGreaterThan(0);
      expect(buzz.score).toBeGreaterThanOrEqual(0);
      expect(buzz.score).toBeLessThanOrEqual(100);
      expect(["BULLISH", "BEARISH", "NEUTRAL"]).toContain(buzz.label);
    } else {
      expect(buzz.reason).toBeTruthy();
    }
  }, 20000);

  it("caches within TTL (second call returns same timestamp)", async () => {
    clearXCache();
    const first = await fetchXBuzz();
    const second = await fetchXBuzz();
    expect(second.fetchedAt).toBe(first.fetchedAt);
  }, 40000);
});
