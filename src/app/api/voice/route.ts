// Voice settings + test/briefing actions (voice output layer, spec §15/§25).

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { loadVoiceSettings, saveVoiceSettings } from "@/lib/voice/voiceConfig";
import { speakTest, speakBriefing, getVoiceStatus, startVoiceService } from "@/lib/voice/voiceService";
import { createProvider } from "@/lib/voice/voiceProvider";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = loadVoiceSettings();
  let voices: string[] = [];
  try {
    voices = fs
      .readdirSync(settings.modelDir)
      .filter((f) => f.endsWith(".onnx"))
      .map((f) => f.replace(/\.onnx$/, ""))
      .sort();
  } catch {}
  let providerAvailable = false;
  try {
    const p = createProvider(settings.provider, {
      piperUrl: settings.piperUrl,
      modelDir: settings.modelDir,
      audioDir: settings.audioDir,
      retentionMin: settings.retentionMin,
    });
    providerAvailable = p ? await p.isAvailable() : false;
  } catch {}
  return NextResponse.json({ settings, voices, providerAvailable, status: getVoiceStatus() });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const settings = saveVoiceSettings(body || {});
    return NextResponse.json({ settings });
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    if (action === "test") {
      const r = await speakTest();
      return NextResponse.json(r, { status: r.status === "ok" ? 200 : 503 });
    }
    if (action === "briefing") {
      const r = await speakBriefing(body?.symbol || "NIFTY");
      return NextResponse.json(r, { status: r.status === "ok" || r.status === "off" ? 200 : 503 });
    }
    if (action === "start") {
      await startVoiceService();
      return NextResponse.json({ ok: true, status: getVoiceStatus() });
    }
    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "voice action failed" }, { status: 500 });
  }
}
