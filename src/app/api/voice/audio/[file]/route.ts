// Serve generated voice audio (temporary files in VOICE_AUDIO_DIR).

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { loadVoiceSettings } from "@/lib/voice/voiceConfig";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ file: string }> }) {
  try {
    const { file } = await ctx.params;
    if (!/^[A-Za-z0-9_-]+\.(ogg|wav)$/.test(file)) {
      return NextResponse.json({ error: "bad filename" }, { status: 400 });
    }
    const dir = path.resolve(loadVoiceSettings().audioDir);
    const full = path.join(dir, file);
    if (!full.startsWith(dir + path.sep) || !fs.existsSync(full)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const buf = fs.readFileSync(full);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": file.endsWith(".ogg") ? "audio/ogg" : "audio/wav",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
