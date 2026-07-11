// Agent Chat — ChatGPT-style voice conversation + text input

"use client";

import { useState, useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Bot,
  Send,
  TrendingUp,
  BarChart3,
  Target,
  Shield,
  Clock,
  Zap,
  Activity,
  Brain,
  AlertTriangle,
  Mic,
  MicOff,
  Volume2,
  Square,
  ArrowUp,
  ArrowDown,
  GripHorizontal,
  GripVertical,
} from "lucide-react";

interface Message {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: Date;
  loading?: boolean;
  toolCallsMade?: string[];
}

interface AgentChatProps {
  symbol: string;
  spotPrice: number;
  analysis: any;
  summary: any;
  gammaBlast: any;
  expiryDate: string;
  // Dashboard data
  dashboardTrades?: any[];
  dashboardChain?: any[];
  dashboardSignal?: any;
  dashboardSpot?: number;
  dashboardAtm?: number;
  dashboardExpiry?: string;
  dashboardVix?: number;
  dashboardPcr?: number;
  dashboardFii?: number;
  dashboardDii?: number;
  dashboardSupport?: number;
  dashboardResistance?: number;
  dashboardMaxPain?: number;
  dashboardChainData?: any[];
}

const QUICK_ACTIONS = [
  { label: "Best Trade", icon: Target, query: "Give me a complete structured trade recommendation with exact entry, SL, targets and reasoning" },
  { label: "ORCA Signal", icon: Brain, query: "Give me the ORCA live signal right now" },
  { label: "Market Structure", icon: TrendingUp, query: "Analyze market structure — trend, S/R, VWAP" },
  { label: "Greeks", icon: Activity, query: "What's the Greeks analysis? Delta, Gamma, Theta, Vega" },
  { label: "OI Analysis", icon: BarChart3, query: "OI buildup patterns — long/short, fresh writing, PCR" },
  { label: "Smart Money", icon: Zap, query: "Any smart money signals? Liquidity sweeps, fakeouts" },
  { label: "Gap Analysis", icon: GripVertical, query: "What's the Gift Nifty gap showing for today's open?" },
  { label: "Correlation", icon: GripHorizontal, query: "Nifty vs Sensex correlation analysis — any drift?" },
  { label: "Scanner", icon: BarChart3, query: "Show me top scanner picks right now" },
];

// ─── Structured Trade Recommendation Card ─────────────────────────
function parseTradeCard(text: string): {
  action: string;
  strike: string;
  entry: string;
  sl: string;
  tp1: string;
  tp2: string;
  confidence: number;
  rr: string;
  bias: string;
  reasons: string[];
} | null {
  const lines = text.split("\n");
  const card: any = { reasons: [] };
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith("- Action:")) card.action = t.split(":")[1]?.trim().split(" ")[0] || "";
    if (t.startsWith("- Entry Price:")) card.entry = t.split("₹")[1]?.trim() || "";
    if (t.startsWith("- Stop Loss:")) card.sl = t.split("₹")[1]?.trim().split(" ")[0] || "";
    if (t.startsWith("- Target 1:")) card.tp1 = t.split("₹")[1]?.trim().split(" ")[0] || "";
    if (t.startsWith("- Target 2:")) card.tp2 = t.split("₹")[1]?.trim().split(" ")[0] || "";
    if (t.startsWith("MARKET BIAS:")) card.bias = t.split(":")[1]?.trim() || "";
    if (t.startsWith("CONFIDENCE SCORE:")) {
      const m = t.match(/(\d+)%/);
      if (m) card.confidence = parseInt(m[1]);
    }
    if (t.startsWith("R:R:")) {
      const m = t.match(/([\d.]+)$/);
      if (m) card.rr = m[1];
    }
    if (t.startsWith("→")) card.reasons.push(t.replace("→", "").trim());
    if (!card.strike && t.includes("BUY") || t.includes("SELL")) {
      const m = t.match(/(BUY|SELL)\s+(\d+)/);
      if (m) { card.action = m[1]; card.strike = m[2]; }
    }
  }
  if (card.action || card.confidence) return card as any;
  return null;
}

function TradeCard({ card }: { card: NonNullable<ReturnType<typeof parseTradeCard>> }) {
  const isBuy = card.action?.toUpperCase().includes("BUY");
  const confColor = card.confidence >= 85 ? "bg-emerald-500" : card.confidence >= 70 ? "bg-amber-500" : "bg-red-500";
  const entryVal = parseFloat(card.entry.replace(/,/g, ""));
  const slVal = parseFloat(card.sl.replace(/,/g, ""));
  const tp1Val = parseFloat(card.tp1.replace(/,/g, ""));
  const riskPct = entryVal && slVal ? Math.abs((entryVal - slVal) / entryVal * 100).toFixed(1) : "—";
  const rewardPct = entryVal && tp1Val ? Math.abs((tp1Val - entryVal) / entryVal * 100).toFixed(1) : "—";

  return (
    <div className="bg-card border border-border/60 rounded-xl p-3 space-y-2.5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`h-6 px-2 rounded-md flex items-center gap-1 text-xs font-bold text-white ${isBuy ? "bg-emerald-600" : "bg-red-600"}`}>
            {isBuy ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {card.action}
          </div>
          {card.strike && <span className="text-xs font-mono font-bold">{card.strike}</span>}
        </div>
        {card.bias && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
            card.bias.includes("BULLISH") ? "bg-emerald-500/10 text-emerald-400" :
            card.bias.includes("BEARISH") ? "bg-red-500/10 text-red-400" :
            "bg-yellow-500/10 text-yellow-400"
          }`}>
            {card.bias}
          </span>
        )}
      </div>

      {/* Price row */}
      <div className="grid grid-cols-4 gap-1 text-center">
        <div className="bg-muted/30 rounded-lg p-1.5">
          <p className="text-[8px] text-muted-foreground">ENTRY</p>
          <p className="text-xs font-bold font-mono text-foreground">₹{card.entry}</p>
        </div>
        <div className="bg-red-500/5 rounded-lg p-1.5 border border-red-500/10">
          <p className="text-[8px] text-red-400">SL</p>
          <p className="text-xs font-bold font-mono text-red-400">₹{card.sl}</p>
          <p className="text-[7px] text-red-400/60">-{riskPct}%</p>
        </div>
        <div className="bg-emerald-500/5 rounded-lg p-1.5 border border-emerald-500/10">
          <p className="text-[8px] text-emerald-400">TP1</p>
          <p className="text-xs font-bold font-mono text-emerald-400">₹{card.tp1}</p>
          <p className="text-[7px] text-emerald-400/60">+{rewardPct}%</p>
        </div>
        {card.tp2 ? (
          <div className="bg-emerald-500/5 rounded-lg p-1.5 border border-emerald-500/10">
            <p className="text-[8px] text-emerald-400">TP2</p>
            <p className="text-xs font-bold font-mono text-emerald-400">₹{card.tp2}</p>
          </div>
        ) : (
          <div className="bg-muted/30 rounded-lg p-1.5">
            <p className="text-[8px] text-muted-foreground">R:R</p>
            <p className="text-xs font-bold font-mono text-foreground">1:{card.rr || "—"}</p>
          </div>
        )}
      </div>

      {/* Confidence bar */}
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${confColor}`} style={{ width: `${card.confidence || 0}%` }} />
        </div>
        <span className={`text-[10px] font-bold font-mono ${confColor.replace("bg-", "text-")}`}>
          {card.confidence || 0}%
        </span>
      </div>

      {/* Reasons */}
      {card.reasons.length > 0 && (
        <div className="space-y-0.5">
          {card.reasons.slice(0, 3).map((r: string, i: number) => (
            <p key={i} className="text-[10px] text-muted-foreground">→ {r}</p>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Detect Structured Trade Card in response ─────────────────
function renderContent(text: string): { html: string; tradeCard: boolean } {
  const tradeCard = text.includes("STRUCTURED TRADE RECOMMENDATION") || text.includes("## TRADE SETUP");
  return {
    html: tradeCard ? "" : renderMarkdown(text),
    tradeCard,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-[11px]">$1</code>')
    .replace(/^• /gm, '<span class="text-primary mr-1">•</span> ')
    .replace(/^---$/gm, '<hr class="border-border my-2" />')
    .replace(/\n/g, '<br />');
}

type VoiceMode = "off" | "listening" | "thinking" | "speaking";

export function AgentChat({
  symbol,
  spotPrice,
  analysis,
  summary,
  gammaBlast,
  expiryDate,
}: AgentChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("off");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [micError, setMicError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null);
  const pendingSpeechRef = useRef("");
  const voiceModeRef = useRef<VoiceMode>("off");
  const autoListenRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);

  // Keep ref in sync
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);

  // Init speech recognition + TTS
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      setSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-IN";
      recognition.maxAlternatives = 3;

      recognition.onresult = (event: any) => {
        let bestTranscript = "";
        for (let i = 0; i < event.results.length; i++) {
          // Pick the alternative with highest confidence
          const alternatives = event.results[i];
          let best = alternatives[0];
          for (let j = 1; j < alternatives.length; j++) {
            if (alternatives[j].confidence > best.confidence) {
              best = alternatives[j];
            }
          }
          bestTranscript += best.transcript;
        }
        setInput(bestTranscript);
        pendingSpeechRef.current = bestTranscript;
      };

      recognition.onend = () => {
        // Only process if we were actually listening (not stopped manually)
        if (voiceModeRef.current === "listening") {
          const text = pendingSpeechRef.current.trim();
          pendingSpeechRef.current = "";
          if (text) {
            setVoiceMode("thinking");
            sendVoiceMessage(text);
          } else {
            // No speech detected — restart listening
            try {
              recognition.start();
            } catch {}
          }
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === "no-speech") {
          // Restart listening silently
          if (voiceModeRef.current === "listening") {
            try { recognition.start(); } catch {}
          }
          return;
        }
        if (event.error === "not-allowed") {
          setMicError("Mic blocked — allow microphone in browser");
        } else if (event.error !== "aborted") {
          setMicError(`Mic error: ${event.error}`);
        }
        setVoiceMode("off");
        setTimeout(() => setMicError(""), 4000);
      };

      recognitionRef.current = recognition;
    }

    if (window.speechSynthesis) {
      setTtsSupported(true);
    }
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Welcome message on mount
  useEffect(() => {
    if (messages.length === 0) {
      const sentiment = analysis?.sentiment || "neutral";
      const sEmoji = sentiment === "bullish" ? "🟢" : sentiment === "bearish" ? "🔴" : "🟡";
      setMessages([
        {
          id: "welcome",
          role: "agent",
          content: `hey sachin! 👋 i'm SDM, your trading buddy.\n\n${sEmoji} **${symbol}** is at ₹${spotPrice.toLocaleString("en-IN")} right now — PCR ${analysis?.pcr?.toFixed(2) || "—"}\n\ni'm watching the markets for you. wanna know about signals, best trades, greeks, or anything else?\n\noh and you can talk to me in hindi too — i got you! 🇮🇳`,
          timestamp: new Date(),
        },
      ]);
    }
  }, [analysis, symbol, spotPrice]);

  // Speak text in chunks (fixes Chrome 15-second cutoff bug)
  const speakChunks = (text: string, voice: SpeechSynthesisVoice | null, onDone: () => void) => {
    // Split into sentences, max ~200 chars each
    const raw = text.replace(/[*#`]/g, "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    const sentences = raw.match(/[^.!?]+[.!?]+\s*/g) || [raw];
    const chunks: string[] = [];
    let buf = "";
    for (const s of sentences) {
      if (buf.length + s.length > 200) {
        if (buf) chunks.push(buf);
        buf = s;
      } else {
        buf += s;
      }
    }
    if (buf) chunks.push(buf);
    if (chunks.length === 0) { onDone(); return; }

    let idx = 0;
    const speakNext = () => {
      if (idx >= chunks.length) { onDone(); return; }
      const utt = new SpeechSynthesisUtterance(chunks[idx]);
      utt.lang = "en-IN";
      utt.rate = 0.95;
      utt.pitch = 1.0;
      utt.volume = 1.0;
      if (voice) utt.voice = voice;
      utt.onend = () => { idx++; speakNext(); };
      utt.onerror = () => { idx++; speakNext(); };
      window.speechSynthesis.speak(utt);
    };
    speakNext();
  };

  const speakAndListen = (text: string) => {
    if (!ttsSupported || !text.trim()) {
      if (voiceModeRef.current !== "off") {
        setVoiceMode("listening");
        try { recognitionRef.current?.start(); } catch {}
      }
      return;
    }

    window.speechSynthesis.cancel();

    const voices = window.speechSynthesis.getVoices();
    const natural = voices.find(v => v.name.includes("Google IN") && v.name.includes("Female"))
      || voices.find(v => v.name.includes("Google IN"))
      || voices.find(v => v.name.includes("Google") && v.lang === "en-IN")
      || voices.find(v => v.name.includes("Microsoft Zira"))
      || voices.find(v => v.name.includes("Microsoft Heera"))
      || voices.find(v => v.name.includes("Google UK English Female"))
      || voices.find(v => v.name.includes("Samantha") && v.lang === "en-US")
      || voices.find(v => v.lang === "en-IN")
      || voices.find(v => v.lang === "en-US")
      || voices.find(v => v.lang.startsWith("en"));

    setVoiceMode("speaking");

    const cleanup = () => {
      if (voiceModeRef.current !== "off") {
        setVoiceMode("listening");
        pendingSpeechRef.current = "";
        try { recognitionRef.current?.start(); } catch {}
      }
    };

    // Safety: max 30 seconds total
    const safetyTimeout = setTimeout(() => {
      window.speechSynthesis.cancel();
      cleanup();
    }, 30000);

    speakChunks(text, natural || null, () => {
      clearTimeout(safetyTimeout);
      cleanup();
    });
  };

  const sendVoiceMessage = async (query: string) => {
    if (!query.trim() || loading) return;
    userStoppedRef.current = false;

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: query.trim(),
      timestamp: new Date(),
    };

    const loadingMsg: Message = {
      id: `a-${Date.now()}`,
      role: "agent",
      content: "",
      timestamp: new Date(),
      loading: true,
    };

    setMessages((prev) => [...prev, userMsg, loadingMsg]);
    setInput("");
    setLoading(true);

    // Abort controller for timeout
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: query,
          symbol,
          spotPrice,
          analysis,
          summary,
          gammaBlast,
          expiryDate,
          // Dashboard data
          dashboardTrades: formattedTrades,
          dashboardChain: chainData,
          dashboardSignal: signal,
          dashboardSpot: spotPrice,
          dashboardAtm: atm,
          dashboardExpiry: expiryDate,
          dashboardVix: vix,
          dashboardPcr: pcr,
          dashboardFii: fii,
          dashboardDii: dii,
          dashboardSupport: support,
          dashboardResistance: resistance,
          dashboardMaxPain: maxPain,
          dashboardChainData: chainData,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data = await res.json();
      const responseText = data.response || "Sorry, I couldn't process that.";

      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, loading: false, content: responseText, toolCallsMade: data.toolCallsMade || [] }
            : m
        )
      );

      setLoading(false);
      abortRef.current = null;

      // Speak the response and start listening again
      speakAndListen(responseText);
    } catch (err: any) {
      clearTimeout(timeout);
      abortRef.current = null;
      if (userStoppedRef.current) {
        userStoppedRef.current = false;
        setLoading(false);
        return;
      }
      const errorText = err.name === "AbortError"
        ? "⚠️ Request timed out. Please try again."
        : "⚠️ Network error. Please try again.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, loading: false, content: errorText }
            : m
        )
      );
      setLoading(false);
      speakAndListen(errorText);
    }
  };

  const sendTextMessage = async (query: string) => {
    if (!query.trim() || loading) return;
    userStoppedRef.current = false;

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: query.trim(),
      timestamp: new Date(),
    };

    const loadingMsg: Message = {
      id: `a-${Date.now()}`,
      role: "agent",
      content: "",
      timestamp: new Date(),
      loading: true,
    };

    setMessages((prev) => [...prev, userMsg, loadingMsg]);
    setInput("");
    setLoading(true);

    // Abort controller for timeout
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: query,
          symbol,
          spotPrice,
          analysis,
          summary,
          gammaBlast,
          expiryDate,
          // Dashboard data
          dashboardTrades: formattedTrades,
          dashboardChain: chainData,
          dashboardSignal: signal,
          dashboardSpot: spotPrice,
          dashboardAtm: atm,
          dashboardExpiry: expiryDate,
          dashboardVix: vix,
          dashboardPcr: pcr,
          dashboardFii: fii,
          dashboardDii: dii,
          dashboardSupport: support,
          dashboardResistance: resistance,
          dashboardMaxPain: maxPain,
          dashboardChainData: chainData,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const data = await res.json();
      const responseText = data.response || "Sorry, I couldn't process that.";

      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, loading: false, content: responseText, toolCallsMade: data.toolCallsMade || [] }
            : m
        )
      );

      // Auto-speak response (chunked, no cutoff)
      if (ttsSupported) {
        window.speechSynthesis.cancel();
        const voices = window.speechSynthesis.getVoices();
        const natural = voices.find(v => v.name.includes("Google IN") && v.name.includes("Female"))
          || voices.find(v => v.name.includes("Google IN"))
          || voices.find(v => v.name.includes("Google") && v.lang === "en-IN")
          || voices.find(v => v.name.includes("Microsoft Zira"))
          || voices.find(v => v.name.includes("Microsoft Heera"))
          || voices.find(v => v.name.includes("Google UK English Female"))
          || voices.find(v => v.name.includes("Samantha") && v.lang === "en-US")
          || voices.find(v => v.lang === "en-IN")
          || voices.find(v => v.lang === "en-US")
          || voices.find(v => v.lang.startsWith("en"));
        speakChunks(responseText, natural || null, () => {});
      }
    } catch (err: any) {
      clearTimeout(timeout);
      if (userStoppedRef.current) {
        userStoppedRef.current = false;
        setLoading(false);
        return;
      }
      const errorText = err.name === "AbortError"
        ? "⚠️ Request timed out. The market data API may be slow. Please try again."
        : "⚠️ Network error. Please try again.";
      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, loading: false, content: errorText }
            : m
        )
      );
    } finally {
      setLoading(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  };

  const stopAgent = () => {
    userStoppedRef.current = true;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    window.speechSynthesis?.cancel();
    setLoading(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.loading
          ? { ...m, loading: false, content: "Stopped." }
          : m
      )
    );
  };

  const toggleVoice = () => {
    if (voiceMode === "off") {
      // Start voice mode
      setVoiceMode("listening");
      pendingSpeechRef.current = "";
      try {
        recognitionRef.current?.start();
      } catch (e) {
        setMicError("Could not start mic");
        setVoiceMode("off");
        setTimeout(() => setMicError(""), 3000);
      }
    } else {
      // Stop voice mode
      setVoiceMode("off");
      window.speechSynthesis?.cancel();
      try {
        recognitionRef.current?.stop();
      } catch {}
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 shrink-0">
        <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center shadow-md">
          <Bot className="h-4 w-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold">SDM <span className="text-[8px] text-emerald-400 font-normal">SDM Trading AI</span></p>
          <p className="text-[9px] text-muted-foreground">
            {symbol} • {analysis?.sentiment?.toUpperCase() || "NEUTRAL"} • Spot ₹{spotPrice.toLocaleString("en-IN")}
          </p>
        </div>
        {voiceMode !== "off" && (
          <Badge
            variant="outline"
            className={`text-[8px] border-0 text-white animate-pulse ${
              voiceMode === "listening" ? "bg-red-500" :
              voiceMode === "thinking" ? "bg-amber-500" :
              "bg-emerald-500"
            }`}
          >
            {voiceMode === "listening" && "🎤 Listening"}
            {voiceMode === "thinking" && "🧠 Thinking"}
            {voiceMode === "speaking" && "🔊 Speaking"}
          </Badge>
        )}
        {voiceMode === "off" && (
          <Badge variant="outline" className="text-[8px] bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
            LIVE
          </Badge>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div ref={scrollRef} className="p-3 space-y-3">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[92%] rounded-xl px-3 py-2 ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border/50"
                }`}
              >
                {msg.loading ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <div className="flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                    Analyzing...
                  </div>
                ) : (
                  <>
                    {msg.toolCallsMade && msg.toolCallsMade.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {msg.toolCallsMade.map((tc) => (
                          <span key={tc} className="inline-flex items-center gap-0.5 text-[8px] bg-violet-500/10 text-violet-400 px-1 py-0.5 rounded">
                            <Zap className="h-2 w-2" />
                            {tc}
                          </span>
                        ))}
                      </div>
                    )}
                    {(() => {
                      const rendered = renderContent(msg.content);
                      if (rendered.tradeCard) {
                        const card = parseTradeCard(msg.content);
                        return card ? (
                          <div className="space-y-2">
                            <TradeCard card={card} />
                            <div
                              className="text-[10px] leading-relaxed text-muted-foreground/70"
                              dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content.replace(/STRUCTURED TRADE RECOMMENDATION[\s\S]*?(?=ALERTS|$)/, "").replace(/^═+$/gm, "").replace(/^## .+/gm, "")) }}
                            />
                          </div>
                        ) : null;
                      }
                      return (
                        <div
                          className="text-[11px] leading-relaxed"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                        />
                      );
                    })()}
                    {msg.role === "agent" && ttsSupported && voiceMode === "off" && (
                      <button
                        onClick={() => {
                          const clean = msg.content.replace(/[*#`]/g, "").replace(/\n+/g, ". ");
                          const utter = new SpeechSynthesisUtterance(clean);
                          utter.lang = "en-IN";
                          utter.rate = 0.9;
                          window.speechSynthesis.speak(utter);
                        }}
                        className="mt-1 text-[8px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                      >
                        <Volume2 className="h-2 w-2" /> Read aloud
                      </button>
                    )}
                  </>
                )}
                <p className="text-[8px] text-muted-foreground mt-1 opacity-60">
                  {msg.timestamp.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Quick Actions */}
      {voiceMode === "off" && (
        <div className="px-2 py-1.5 border-t border-border/50 shrink-0 overflow-x-auto">
          <div className="flex items-center gap-1">
            {QUICK_ACTIONS.map((qa) => (
              <Button
                key={qa.label}
                variant="ghost"
                size="sm"
                className="h-6 text-[9px] px-1.5 shrink-0 gap-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => sendTextMessage(qa.query)}
                disabled={loading}
              >
                <qa.icon className="h-2.5 w-2.5" />
                {qa.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Voice Mode Indicator */}
      {voiceMode !== "off" && (
        <div className="px-3 py-2 border-t border-border/50 shrink-0 text-center">
          <div className="flex items-center justify-center gap-2">
            <div className={`w-2 h-2 rounded-full ${
              voiceMode === "listening" ? "bg-red-500 animate-pulse" :
              voiceMode === "thinking" ? "bg-amber-500 animate-pulse" :
              "bg-emerald-500 animate-pulse"
            }`} />
            <span className="text-xs text-muted-foreground font-mono">
              {voiceMode === "listening" && "SDM ONLINE — Awaiting command"}
              {voiceMode === "thinking" && "Processing query..."}
              {voiceMode === "speaking" && "Delivering analysis..."}
            </span>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="px-3 py-2 border-t border-border/50 shrink-0">
        {micError && (
          <div className="text-[9px] text-red-400 mb-1 flex items-center gap-1">
            <AlertTriangle className="h-2.5 w-2.5" /> {micError}
          </div>
        )}
        {!speechSupported && (
          <div className="text-[9px] text-yellow-500 mb-1">
            Voice not supported — use Chrome or Edge
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendTextMessage(input);
          }}
          className={`flex items-center gap-2 ${loading ? "agent-loading" : ""}`}
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={loading ? "SDM is thinking..." : voiceMode === "listening" ? "🎤 Listening..." : "Ask about market, trades, levels..."}
            className="h-8 text-xs"
            disabled={loading}
          />
          <Button
            type="button"
            size="sm"
            variant={voiceMode !== "off" ? "destructive" : "ghost"}
            className={`h-8 w-8 p-0 shrink-0 ${
              voiceMode === "listening" ? "bg-red-600 text-white animate-pulse" :
              voiceMode === "thinking" ? "bg-amber-600 text-white animate-pulse" :
              voiceMode === "speaking" ? "bg-emerald-600 text-white animate-pulse" :
              "text-muted-foreground hover:text-foreground"
            }`}
            onClick={toggleVoice}
            title={voiceMode === "off" ? "Start voice chat" : "Stop voice chat"}
          >
            {voiceMode === "off" ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-8 w-8 p-0 shrink-0 animate-pulse agent-stop"
            onClick={stopAgent}
            title="Stop agent"
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="submit"
            size="sm"
            className="h-8 w-8 p-0 shrink-0 bg-violet-600 hover:bg-violet-700 text-white agent-send"
            disabled={!input.trim()}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </form>
      </div>
    </div>
  );
}
