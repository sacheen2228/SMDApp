// /api/quant/config — view + set the file-backed runtime overrides for
// UNIVERSAL_QUANT_V1 (data/quant-config.json). Writes require the
// QUANT_ADMIN_SECRET (POST body {secret, patch}); GET is read-only.

import { NextRequest, NextResponse } from "next/server";
import {
  getQuantRuntimeConfig,
  setQuantRuntimeConfig,
  quantEnabled,
  effectiveMode,
  effectivePaperCapital,
  effectiveSymbols,
  effectiveTuning,
  type QuantRuntimeConfig,
} from "@/lib/quant/quant-runtime-config";

export const dynamic = "force-dynamic";

const SETTABLE_DOC = {
  enabled: "boolean — arm/disarm the engine (runtime override of QUANT_ENABLED)",
  mode: '"SHADOW" | "PAPER" — PAPER simulates fills and opens QuantPaperTrade rows; SHADOW logs decisions only',
  paperCapital: "number | null — paper account capital in ₹ (null = unconfigured → risk block, never assumed)",
  symbols: "string[] (max 10) — instruments the engine cycles over",
  tuning: {
    minScore: "number 0..100 — strategy score gate (default 55)",
    minRewardRisk: "number — plan R:R floor; the ladder is 1:2 / 1:3 / 1:5, so a floor above 2 blocks every trade",
    maxTradesPerDay: "number | null — null = unlimited (quality gates only)",
    maxConcurrentPositions: "number | null — null = unlimited (quality gates only)",
    requireChainConfirm: "boolean — candidate must not be contradicted by live OI/PCR structure",
  },
};

function effective() {
  return {
    enabled: quantEnabled(),
    mode: effectiveMode(),
    paperCapital: effectivePaperCapital(),
    symbols: effectiveSymbols(),
    tuning: effectiveTuning(),
  };
}

function sanitizePatch(raw: any): Partial<QuantRuntimeConfig> {
  const patch: Partial<QuantRuntimeConfig> = {};
  if (!raw || typeof raw !== "object") return patch;
  if (typeof raw.enabled === "boolean") patch.enabled = raw.enabled;
  if (raw.mode === "SHADOW" || raw.mode === "PAPER") patch.mode = raw.mode;
  if (raw.paperCapital === null) patch.paperCapital = null;
  else if (typeof raw.paperCapital === "number" && Number.isFinite(raw.paperCapital) && raw.paperCapital > 0) {
    patch.paperCapital = raw.paperCapital;
  }
  if (Array.isArray(raw.symbols)) {
    const symbols = raw.symbols
      .filter((s: unknown) => typeof s === "string" && s.trim() !== "")
      .map((s: string) => s.trim().toUpperCase())
      .slice(0, 10);
    if (symbols.length > 0) patch.symbols = symbols;
  }
  if (raw.tuning && typeof raw.tuning === "object" && !Array.isArray(raw.tuning)) {
    const t: NonNullable<QuantRuntimeConfig["tuning"]> = {};
    const rt = raw.tuning;
    if (typeof rt.minScore === "number" && Number.isFinite(rt.minScore) && rt.minScore >= 0 && rt.minScore <= 100) t.minScore = rt.minScore;
    if (typeof rt.minRewardRisk === "number" && Number.isFinite(rt.minRewardRisk) && rt.minRewardRisk >= 0) t.minRewardRisk = rt.minRewardRisk;
    // null = unlimited (no cap) — an explicit null is honoured.
    if (rt.maxTradesPerDay === null) t.maxTradesPerDay = null;
    else if (typeof rt.maxTradesPerDay === "number" && Number.isFinite(rt.maxTradesPerDay) && rt.maxTradesPerDay >= 0) t.maxTradesPerDay = rt.maxTradesPerDay;
    if (rt.maxConcurrentPositions === null) t.maxConcurrentPositions = null;
    else if (typeof rt.maxConcurrentPositions === "number" && Number.isFinite(rt.maxConcurrentPositions) && rt.maxConcurrentPositions >= 0) t.maxConcurrentPositions = rt.maxConcurrentPositions;
    if (typeof rt.requireChainConfirm === "boolean") t.requireChainConfirm = rt.requireChainConfirm;
    patch.tuning = t;
  }
  return patch;
}

export async function GET() {
  try {
    return NextResponse.json({
      success: true,
      engineVersion: "UNIVERSAL_QUANT_V1",
      effective: effective(),
      file: getQuantRuntimeConfig(),
      settable: SETTABLE_DOC,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "config failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const adminSecret = process.env.QUANT_ADMIN_SECRET;
    if (!adminSecret || body?.secret !== adminSecret) {
      return NextResponse.json({ success: false, error: "unauthorized" }, { status: 403 });
    }
    const patch = sanitizePatch(body?.patch);
    const file = setQuantRuntimeConfig(patch);
    return NextResponse.json({ success: true, effective: effective(), file, applied: patch });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message ?? "config write failed" }, { status: 500 });
  }
}
