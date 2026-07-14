import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// --- API rate limiting + key check (preserved from former src/middleware.ts) ---
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

const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function applyRateLimit(request: NextRequest): NextResponse | null {
  const pathname = request.nextUrl.pathname;
  // Only act on API routes (and never on NextAuth's own endpoints).
  if (!pathname.startsWith("/api/") || pathname.startsWith("/api/auth")) return null;

  const ip =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
    lastCleanup = Date.now();
    const now = Date.now();
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }

  const isWrite =
    request.method === "POST" ||
    request.method === "PUT" ||
    request.method === "DELETE";

  if (pathname.startsWith("/api/orders")) {
    if (isWrite && !rateLimit(`orders:${ip}`, 5, 60_000)) {
      return NextResponse.json(
        { error: "Rate limit: max 5 order actions per minute" },
        { status: 429 }
      );
    }
    if (!isWrite && !rateLimit(`orders:read:${ip}`, 20, 60_000)) {
      return NextResponse.json(
        { error: "Rate limit: max 20 reads per minute" },
        { status: 429 }
      );
    }
  }

  if (pathname.startsWith("/api/agent") && isWrite) {
    if (!rateLimit(`agent:${ip}`, 10, 60_000)) {
      return NextResponse.json(
        { error: "Rate limit: max 10 agent messages per minute" },
        { status: 429 }
      );
    }
  }

  if (pathname.startsWith("/api/scanner")) {
    if (!rateLimit(`scanner:${ip}`, 5, 60_000)) {
      return NextResponse.json(
        { error: "Rate limit: max 5 scanner calls per minute" },
        { status: 429 }
      );
    }
  }

  if (pathname.startsWith("/api/news")) {
    if (!rateLimit(`news:${ip}`, 10, 60_000)) {
      return NextResponse.json(
        { error: "Rate limit: max 10 news calls per minute" },
        { status: 429 }
      );
    }
  }

  if (pathname.startsWith("/api/backtest")) {
    if (!rateLimit(`backtest:${ip}`, 20, 60_000)) {
      return NextResponse.json(
        { error: "Rate limit: max 20 backtest calls per minute" },
        { status: 429 }
      );
    }
  }

  if (
    !isWrite &&
    !pathname.startsWith("/api/orders") &&
    !pathname.startsWith("/api/agent") &&
    !pathname.startsWith("/api/scanner") &&
    !pathname.startsWith("/api/news") &&
    !pathname.startsWith("/api/backtest")
  ) {
    if (!rateLimit(`api:${ip}`, 60, 60_000)) {
      return NextResponse.json(
        { error: "Rate limit: max 60 requests per minute" },
        { status: 429 }
      );
    }
  }

  const apiKey = request.headers.get("x-api-key");
  const isSensitiveWrite =
    isWrite &&
    (pathname.startsWith("/api/orders") ||
      pathname.startsWith("/api/trade-journal"));
  if (
    isSensitiveWrite &&
    process.env.API_SECRET_KEY &&
    apiKey !== process.env.API_SECRET_KEY
  ) {
    return NextResponse.json(
      { error: "Unauthorized: missing or invalid x-api-key header" },
      { status: 401 }
    );
  }

  return null;
}

// Edge-safe config (NO Prisma adapter here) — imported by src/proxy.ts.
// The full config (with adapter) lives in src/auth.ts.
export const authConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized({ auth, request }) {
      // Rate-limit / key-check API routes first; block with 429/401 if exceeded.
      const blocked = applyRateLimit(request as NextRequest);
      if (blocked) return blocked;

      const { pathname } = request.nextUrl;
      // Public: landing page, login page, NextAuth's own callback routes, and
      // ALL /api routes. APIs are rate-limited above but must stay reachable
      // without a session (the browser calls them before/without login).
      const isPublic =
        pathname === "/" ||
        pathname === "/login" ||
        pathname.startsWith("/api/");
      if (isPublic) return true;

      // Every other page requires a session; otherwise redirect to /login.
      return !!auth?.user;
    },
  },
} satisfies NextAuthConfig;

// Edge-safe Auth.js instance (NO Prisma adapter). The proxy runs in the
// Edge runtime and must only validate the JWT session — it cannot reach the
// database. JWT sessions make `auth.user` readable here without a DB query.
export const { auth } = NextAuth(authConfig);
