// POST /api/jarvis/chat — Jarvis chat-first endpoint (the LLM conversation
// behind the Jarvis tab's chat view).
//
// Routing (all deterministic except the reply text itself):
//   guard  → bypass language declined straight from JARVIS_PROMPT rule 8,
//            no LLM consulted, restate the blocking gate from the signal.
//   direct → single-shot narration: JARVIS_PROMPT + SIGNAL JSON + prior
//            turns, no tools — cannot drift through a tool loop.
//   open   → same call in "open" mode (signal pinned as ground truth,
//            beyond-signal questions allowed), then the diff backstop:
//            if the text contradicts the signal's action/strike it is
//            discarded and the deterministic readout is served instead.
//
// Reads ONLY via getJarvisSignal() (worker cache first) — never touches
// AlertSink, so no chat message can ever send a Telegram alert.

import { NextRequest, NextResponse } from "next/server";
import {
  getJarvisSignal,
  routeJarvisChat,
  narrateJarvisSignal,
  formatJarvisChat,
  formatJarvisGateDecline,
  hermesResponseMatchesSignal,
} from "@/lib/jarvis-adapters";
import { maybeHandleKillSwitch, killSwitchMessage } from "@/lib/agents/kill-switch";
import type { LLMMessage } from "@/lib/llm-client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const message: string = typeof body?.message === "string" ? body.message.trim() : "";
    const symbol: string = typeof body?.symbol === "string" && body.symbol ? body.symbol : "NIFTY";
    const history: LLMMessage[] = Array.isArray(body?.history)
      ? body.history.slice(-8).filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      : [];

    if (!message) {
      return NextResponse.json({ success: false, error: "Message required" }, { status: 400 });
    }

    // v2 §10 — kill switch: "Hermes, stop all trading" / "CONFIRM RESUME TRADING"
    // handled before any signal read or LLM call. Monitoring is never gated.
    const ks = maybeHandleKillSwitch(message);
    if (ks) {
      return NextResponse.json({
        success: true,
        response: killSwitchMessage(ks),
        route: "kill_switch",
        killSwitch: ks,
      });
    }

    const read = await getJarvisSignal(symbol);
    if (!read) {
      return NextResponse.json({ success: false, error: `no signal for ${symbol}` }, { status: 503 });
    }

    const route = routeJarvisChat(message, read.signal);
    const s = read.signal;
    console.log(
      `[jarvis-chat] route=${route} instrument=${s.instrument} action=${s.action} source=${read.source} q="${message.slice(0, 100)}"`
    );

    if (route === "guard") {
      const resp = formatJarvisGateDecline(read);
      return NextResponse.json({
        success: true,
        response: resp,
        route,
        jarvis: { action: s.action, instrument: s.instrument, source: read.source },
      });
    }

    const resp = await narrateJarvisSignal(message, read, history, route === "open" ? "open" : "direct");

    // Diff backstop — only for OPEN replies (direct narration is built from
    // the signal JSON itself, but the LLM can still slip an opposite call
    // into an opinionated answer).
    let backstop = false;
    let final = resp;
    if (route === "open" && !hermesResponseMatchesSignal(resp, s)) {
      console.log(`[jarvis-backstop] FIRED (chat) discarded="${resp.slice(0, 120)}"`);
      final = formatJarvisChat(read);
      backstop = true;
    }

    return NextResponse.json({
      success: true,
      response: final,
      route,
      backstop,
      jarvis: { action: s.action, instrument: s.instrument, source: read.source, biasScore: s.biasScore },
    });
  } catch (error: any) {
    console.warn("[jarvis-chat] failed:", error?.message || error);
    return NextResponse.json(
      { success: false, error: String(error?.message || error) },
      { status: 502 }
    );
  }
}
