// API Middleware — rate limiting + basic auth for sensitive routes

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// In-memory rate limiter (per IP, resets on cold start)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// Clean up stale entries every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Only apply to API routes
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Rate limiting — get client IP
  const ip = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  // Periodic cleanup
  if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
    lastCleanup = Date.now();
    const now = Date.now();
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  // Different limits per route category
  const isWrite = request.method === "POST" || request.method === "PUT" || request.method === "DELETE";

  // Order placement — strictest (5/min write, 20/min read)
  if (pathname.startsWith("/api/orders")) {
    if (isWrite && !rateLimit(`orders:${ip}`, 5, 60_000)) {
      return NextResponse.json({ error: "Rate limit: max 5 order actions per minute" }, { status: 429 });
    }
    if (!isWrite && !rateLimit(`orders:read:${ip}`, 20, 60_000)) {
      return NextResponse.json({ error: "Rate limit: max 20 reads per minute" }, { status: 429 });
    }
  }

  // Agent — LLM calls are expensive (10/min)
  if (pathname.startsWith("/api/agent") && isWrite) {
    if (!rateLimit(`agent:${ip}`, 10, 60_000)) {
      return NextResponse.json({ error: "Rate limit: max 10 agent messages per minute" }, { status: 429 });
    }
  }

  // Scanner — makes external HTTP calls (5/min)
  if (pathname.startsWith("/api/scanner")) {
    if (!rateLimit(`scanner:${ip}`, 5, 60_000)) {
      return NextResponse.json({ error: "Rate limit: max 5 scanner calls per minute" }, { status: 429 });
    }
  }

  // News — external RSS feeds (10/min)
  if (pathname.startsWith("/api/news")) {
    if (!rateLimit(`news:${ip}`, 10, 60_000)) {
      return NextResponse.json({ error: "Rate limit: max 10 news calls per minute" }, { status: 429 });
    }
  }

  // Backtest — CPU-intensive (3/min)
  if (pathname.startsWith("/api/backtest")) {
    if (!rateLimit(`backtest:${ip}`, 3, 60_000)) {
      return NextResponse.json({ error: "Rate limit: max 3 backtest calls per minute" }, { status: 429 });
    }
  }

  // General API rate limit (60/min for reads)
  if (!isWrite && !pathname.startsWith("/api/orders") && !pathname.startsWith("/api/agent") && !pathname.startsWith("/api/scanner") && !pathname.startsWith("/api/news") && !pathname.startsWith("/api/backtest")) {
    if (!rateLimit(`api:${ip}`, 60, 60_000)) {
      return NextResponse.json({ error: "Rate limit: max 60 requests per minute" }, { status: 429 });
    }
  }

  // Basic API key check for sensitive write routes (orders, trade-journal)
  const apiKey = request.headers.get("x-api-key");
  const isSensitiveWrite = isWrite && (pathname.startsWith("/api/orders") || pathname.startsWith("/api/trade-journal"));
  if (isSensitiveWrite && process.env.API_SECRET_KEY && apiKey !== process.env.API_SECRET_KEY) {
    return NextResponse.json({ error: "Unauthorized: missing or invalid x-api-key header" }, { status: 401 });
  }

  // Security headers
  const response = NextResponse.next();
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-XSS-Protection", "1; mode=block");

  return response;
}

export const config = {
  matcher: ["/api/:path*"],
};
