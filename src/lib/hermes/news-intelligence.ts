// NOUS HERMES — News Intelligence
// Persistent news scanning, deduplication, entity extraction, impact assessment
// Uses existing news-engine.ts RSS feeds + adds intelligence layer

import { fetchMarketNews, type NewsArticle } from '@/lib/news-engine';

// ── News Event Types ──
export type NewsImpact = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type NewsBias = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';

export interface NewsEvent {
  id: string;
  title: string;
  description: string;
  source: string;
  url: string;
  publishedAt: string;
  retrievedAt: string;
  entities: string[];       // extracted stock/index names
  sector: string;            // detected sector
  category: string;          // earnings/regulatory/corporate/market/geopolitical
  impact: NewsImpact;
  bias: NewsBias;
  sentimentScore: number;    // -1 to +1
  marketConfirmation: boolean;
  action: 'WATCH' | 'MONITOR' | 'IGNORE';
  overnightRelevance: boolean;
}

export interface NewsIntelligenceResult {
  totalScanned: number;
  relevant: number;
  critical: number;
  overnight: number;
  events: NewsEvent[];
  sectorSummary: Record<string, { count: number; bias: NewsBias }>;
  timestamp: string;
}

// ── Sector Detection ──
const SECTOR_KEYWORDS: Record<string, string[]> = {
  Banking: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK', 'bank', 'banking', ' RBI', 'interest rate'],
  IT: ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'IT ', 'software', 'digital'],
  FMCG: ['HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'FMCG', 'consumer goods'],
  Pharma: ['SUNPHARMA', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'pharma', 'drug', 'FDA'],
  Auto: ['MARUTI', 'TATAMOTORS', 'M&M', 'EICHERMOT', 'HEROMOTOCO', 'auto', 'vehicle', 'EV'],
  Energy: ['RELIANCE', 'ONGC', 'BPCL', 'POWERGRID', 'NTPC', 'crude', 'oil', 'gas', 'energy'],
  Metal: ['TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'metal', 'steel', 'aluminium', 'copper'],
  Infrastructure: ['LT', 'ADANIPORTS', 'infra', 'construction', 'cement'],
  NBFC: ['BAJFINANCE', 'BAJAJFINSV', 'HDFCAMC', 'NBFC', 'finance'],
  Telecom: ['BHARTIARTL', 'telecom', '5G', 'spectrum'],
  Insurance: ['HDFCLIFE', 'SBILIFE', 'insurance'],
  Conglomerate: ['ADANIENT', 'TRENT', 'conglomerate'],
};

// ── Category Detection ──
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  earnings: ['result', 'quarterly', 'earnings', 'profit', 'loss', 'revenue', 'EBITDA', 'PAT'],
  regulatory: ['SEBI', 'RBI', 'regulatory', 'ban', 'restriction', 'guideline', 'circular'],
  corporate: ['merger', 'acquisition', 'buyback', 'dividend', 'bonus', 'split', 'stake'],
  geopolitical: ['war', 'sanction', 'geopolitical', 'tariff', 'trade war', 'conflict'],
  macro: ['inflation', 'GDP', 'employment', 'PMI', 'factory output', 'CPI', 'WPI'],
};

// ── News Intelligence Engine ──
class NewsIntelligence {
  private static instance: NewsIntelligence;
  private recentEventIds: Set<string> = new Set();
  private eventHistory: NewsEvent[] = [];
  private MAX_HISTORY = 500;

  static getInstance(): NewsIntelligence {
    if (!NewsIntelligence.instance) {
      NewsIntelligence.instance = new NewsIntelligence();
    }
    return NewsIntelligence.instance;
  }

  // ── Scan for news events ──
  async scan(symbol?: string, limit: number = 50): Promise<NewsIntelligenceResult> {
    const result: NewsIntelligenceResult = {
      totalScanned: 0,
      relevant: 0,
      critical: 0,
      overnight: 0,
      events: [],
      sectorSummary: {},
      timestamp: new Date().toISOString(),
    };

    try {
      const sentiment = await fetchMarketNews();
      const articles = sentiment.articles || [];
      result.totalScanned = articles.length;

      for (const article of articles) {
        const event = this.processArticle(article);
        if (!event) continue;

        // Deduplication
        if (this.recentEventIds.has(event.id)) continue;
        this.recentEventIds.add(event.id);

        result.events.push(event);
        result.relevant++;

        if (event.impact === 'CRITICAL') result.critical++;
        if (event.overnightRelevance) result.overnight++;

        // Sector summary
        if (event.sector && event.sector !== 'Unknown') {
          if (!result.sectorSummary[event.sector]) {
            result.sectorSummary[event.sector] = { count: 0, bias: 'NEUTRAL' };
          }
          result.sectorSummary[event.sector].count++;
          if (event.bias === 'NEGATIVE') result.sectorSummary[event.sector].bias = 'NEGATIVE';
          else if (event.bias === 'POSITIVE' && result.sectorSummary[event.sector].bias !== 'NEGATIVE') {
            result.sectorSummary[event.sector].bias = 'POSITIVE';
          }
        }
      }

      // Store in history
      this.eventHistory.push(...result.events);
      if (this.eventHistory.length > this.MAX_HISTORY) {
        this.eventHistory = this.eventHistory.slice(-this.MAX_HISTORY);
      }

    } catch (err: any) {
      console.error('[NOUS-NEWS] Scan error:', err.message?.substring(0, 100));
    }

    return result;
  }

  // ── Process a single article ──
  private processArticle(article: NewsArticle): NewsEvent | null {
    if (!article.title) return null;

    const title = article.title;
    const desc = article.description || '';
    const combined = `${title} ${desc}`.toUpperCase();

    // Extract entities (stock symbols)
    const entities = this.extractEntities(combined);

    // Detect sector
    const sector = this.detectSector(combined, entities);

    // Detect category
    const category = this.detectCategory(combined);

    // Calculate bias and sentiment
    const bias = this.detectBias(combined);
    const sentimentScore = article.sentiment || 0;

    // Assess impact
    const impact = this.assessImpact(combined, entities, category);

    // Overnight relevance
    const overnightRelevance = this.isOvernightRelevant(combined, category, impact);

    return {
      id: `${article.source}-${Buffer.from(title).toString('base64').substring(0, 20)}`,
      title,
      description: desc.substring(0, 200),
      source: article.source || 'Unknown',
      url: article.link || '',
      publishedAt: article.pubDate || new Date().toISOString(),
      retrievedAt: new Date().toISOString(),
      entities,
      sector,
      category,
      impact,
      bias,
      sentimentScore,
      marketConfirmation: false,
      action: impact === 'CRITICAL' || impact === 'HIGH' ? 'WATCH' : 'MONITOR',
      overnightRelevance,
    };
  }

  // ── Entity Extraction ──
  private extractEntities(text: string): string[] {
    const entities: string[] = [];
    const allSymbols = [
      'NIFTY', 'BANKNIFTY', 'SENSEX', 'MIDCPNIFTY', 'FINNIFTY',
      'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC', 'SBIN',
      'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'BAJFINANCE', 'ASIANPAINT', 'MARUTI',
      'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'NESTLEIND', 'TATAMOTORS', 'WIPRO', 'M&M',
      'HCLTECH', 'POWERGRID', 'NTPC', 'ONGC', 'TATASTEEL', 'JSWSTEEL', 'ADANIENT',
      'ADANIPORTS', 'TECHM', 'HDFCLIFE', 'SBILIFE', 'BRITANNIA', 'CIPLA', 'DRREDDY',
      'DIVISLAB', 'EICHERMOT', 'GRASIM', 'HEROMOTOCO', 'HINDALCO', 'INDUSINDBK',
      'BAJAJFINSV', 'COALINDIA', 'BPCL', 'TRENT', 'APOLLOHOSP', 'LTIM', 'HDFCAMC',
      'CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS',
    ];

    for (const sym of allSymbols) {
      if (text.includes(sym)) entities.push(sym);
    }

    return [...new Set(entities)];
  }

  // ── Sector Detection ──
  private detectSector(text: string, entities: string[]): string {
    for (const [sector, keywords] of Object.entries(SECTOR_KEYWORDS)) {
      for (const kw of keywords) {
        if (text.includes(kw.toUpperCase()) || entities.some(e => kw.toUpperCase().includes(e))) {
          return sector;
        }
      }
    }
    return 'Unknown';
  }

  // ── Category Detection ──
  private detectCategory(text: string): string {
    for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      for (const kw of keywords) {
        if (text.includes(kw.toUpperCase())) return cat;
      }
    }
    return 'general';
  }

  // ── Bias Detection ──
  private detectBias(text: string): NewsBias {
    const positiveWords = ['surge', 'rally', 'gain', 'profit', 'growth', 'bullish', 'upgrade', 'buy', 'outperform', 'beat', 'strong', 'record high', 'breakout'];
    const negativeWords = ['crash', 'fall', 'drop', 'loss', 'decline', 'bearish', 'downgrade', 'sell', 'underperform', 'miss', 'weak', 'record low', 'breakdown', 'ban', 'restrict'];

    let posCount = 0;
    let negCount = 0;
    for (const w of positiveWords) { if (text.includes(w.toUpperCase())) posCount++; }
    for (const w of negativeWords) { if (text.includes(w.toUpperCase())) negCount++; }

    if (posCount > negCount + 1) return 'POSITIVE';
    if (negCount > posCount + 1) return 'NEGATIVE';
    if (posCount > 0 && negCount > 0) return 'MIXED';
    return 'NEUTRAL';
  }

  // ── Impact Assessment ──
  private assessImpact(text: string, entities: string[], category: string): NewsImpact {
    let score = 0;

    // Category weight
    if (category === 'regulatory') score += 3;
    else if (category === 'earnings') score += 2;
    else if (category === 'geopolitical') score += 2;
    else if (category === 'macro') score += 1;

    // Entity weight (indices = higher impact)
    if (entities.some(e => ['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(e))) score += 2;
    if (entities.length > 3) score += 1;

    // Sentiment intensity
    const intenseWords = ['surge', 'crash', 'record', 'ban', 'war', 'crisis', 'emergency'];
    for (const w of intenseWords) {
      if (text.includes(w.toUpperCase())) score += 1;
    }

    if (score >= 5) return 'CRITICAL';
    if (score >= 3) return 'HIGH';
    if (score >= 1) return 'MEDIUM';
    return 'LOW';
  }

  // ── Overnight Relevance ──
  private isOvernightRelevant(text: string, category: string, impact: NewsImpact): boolean {
    if (impact === 'CRITICAL' || impact === 'HIGH') return true;
    if (category === 'geopolitical' || category === 'macro') return true;
    if (text.includes('US MARKET') || text.includes('ASIAN MARKET') || text.includes('GLOBAL')) return true;
    return false;
  }

  // ── Get recent events ──
  getRecentEvents(limit: number = 50): NewsEvent[] {
    return this.eventHistory.slice(-limit);
  }

  // ── Get events by entity ──
  getEventsByEntity(entity: string): NewsEvent[] {
    return this.eventHistory.filter(e => e.entities.includes(entity));
  }

  // ── Get critical events ──
  getCriticalEvents(): NewsEvent[] {
    return this.eventHistory.filter(e => e.impact === 'CRITICAL' || e.impact === 'HIGH');
  }
}

// ── Singleton ──
export const newsIntelligence = NewsIntelligence.getInstance();

// ── Convenience ──
export const scanNews = (symbol?: string, limit?: number) =>
  newsIntelligence.scan(symbol, limit);

export const getRecentNewsEvents = (limit?: number) =>
  newsIntelligence.getRecentEvents(limit);

export const getCriticalNewsEvents = () =>
  newsIntelligence.getCriticalEvents();
