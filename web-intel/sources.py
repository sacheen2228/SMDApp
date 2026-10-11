"""Phase 5 — Web Intelligence source registry.

Free public RSS/Atom endpoints only (no API keys). Each source carries a
stable `name` (provenance), a category (used by TS-side enrichment for
impact assessment) and a weight (news-engine style importance 0..1).

Health probes (2026-10-07):
  200 — ET, LiveMint, Business Standard, CNBC-TV18, Investing.com,
        NDTV Profit, SEBI sebirss.xml, RBI pressreleases_rss.xml,
        BSE news-topstories.rss, Google News queries, Dow Jones markets
  503 — Moneycontrol RSS (bot-block; Google News site: proxy used)
  404 — NSE RSS (no official RSS; Google News site: proxy used)
  dead — Reuters official feed (Google News site: proxy used)

Sources are evidence only. Nothing here ever creates a trade.
"""

# kind: "rss" = parse as RSS/Atom XML
# category: markets | global | regulatory | corporate | macro
SOURCES = [
    # ── India markets ────────────────────────────────────────────
    {"name": "Economic Times", "url": "https://economictimes.indiatimes.com/rssfeedstopstories.cms", "kind": "rss", "category": "markets", "weight": 0.9},
    {"name": "LiveMint", "url": "https://www.livemint.com/rss/markets", "kind": "rss", "category": "markets", "weight": 0.9},
    {"name": "Business Standard", "url": "https://www.business-standard.com/rss/markets-106.rss", "kind": "rss", "category": "markets", "weight": 0.9},
    {"name": "CNBC-TV18", "url": "https://www.cnbctv18.com/rss/market", "kind": "rss", "category": "markets", "weight": 0.85},
    {"name": "Investing.com", "url": "https://in.investing.com/rss/news.rss", "kind": "rss", "category": "markets", "weight": 0.8},
    {"name": "NDTV Profit", "url": "https://feeds.feedburner.com/ndtvprofit-latest", "kind": "rss", "category": "markets", "weight": 0.8},
    # Proxied via Google News RSS (Moneycontrol direct = 503, NSE RSS = 404)
    {"name": "Moneycontrol (via Google News)", "url": "https://news.google.com/rss/search?q=site:moneycontrol.com+market&hl=en-IN&gl=IN&ceid=IN:en", "kind": "rss", "category": "markets", "weight": 0.9},
    {"name": "NSE India (via Google News)", "url": "https://news.google.com/rss/search?q=site:nseindia.com&hl=en-IN&gl=IN&ceid=IN:en", "kind": "rss", "category": "markets", "weight": 0.8},
    {"name": "BSE India", "url": "https://www.bseindia.com/rss/news-topstories.rss", "kind": "rss", "category": "markets", "weight": 0.85},
    # ── Regulators (RBI / SEBI) ──────────────────────────────────
    {"name": "SEBI", "url": "https://www.sebi.gov.in/sebirss.xml", "kind": "rss", "category": "regulatory", "weight": 1.0},
    {"name": "RBI", "url": "https://www.rbi.org.in/pressreleases_rss.xml", "kind": "rss", "category": "regulatory", "weight": 1.0},
    # ── Global / US markets (Reuters direct feed is dead → proxy) ─
    {"name": "Reuters (via Google News)", "url": "https://news.google.com/rss/search?q=site:reuters.com+markets&hl=en-US&gl=US&ceid=US:en", "kind": "rss", "category": "global", "weight": 0.9},
    {"name": "Dow Jones Markets", "url": "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", "kind": "rss", "category": "global", "weight": 0.85},
    # ── Macro / commodities (crude, gold, USDINR) ────────────────
    {"name": "Google News — crude oil", "url": "https://news.google.com/rss/search?q=crude+oil+price&hl=en-IN&gl=IN&ceid=IN:en", "kind": "rss", "category": "macro", "weight": 0.8},
    {"name": "Google News — gold", "url": "https://news.google.com/rss/search?q=gold+price&hl=en-IN&gl=IN&ceid=IN:en", "kind": "rss", "category": "macro", "weight": 0.8},
    {"name": "Google News — USDINR", "url": "https://news.google.com/rss/search?q=USDINR+rupee+dollar&hl=en-IN&gl=IN&ceid=IN:en", "kind": "rss", "category": "macro", "weight": 0.8},
    {"name": "Google News — Indian stock market", "url": "https://news.google.com/rss/search?q=indian+stock+market+NSE+BSE&hl=en-IN&gl=IN&ceid=IN:en", "kind": "rss", "category": "markets", "weight": 0.7},
]
