// Agent Chat — SDM trading assistant (focused trade hub)
// Deterministic, live-data trade bot. Talks in EN + Hindi, supports
// voice. Renders structured TradeAlert cards and graceful fallbacks.

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
  Mic,
  MicOff,
  Volume2,
  Square,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Sparkles,
  TrendingUp,
  Newspaper,
  Link2,
  Building2,
  Scan,
  Activity,
  Moon,
  ClipboardList,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────
interface TradeAlert {
  id: string;
  kind: "option" | "equity";
  symbol: string;
  side: "BUY" | "SELL";
  instrument: string;
  strike?: number;
  optionType?: "CE" | "PE";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  rr: 1 | 2 | 3 | 4;
  confidence: number;
  rationale: string;
  expiry?: string;
  generatedAt: string;
}

interface SDMResponse {
  text: string;
  language: "en" | "hi";
  alert: TradeAlert | null;
}

interface Message {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: Date;
  loading?: boolean;
  alert?: TradeAlert | null;
  language?: "en" | "hi";
}

interface AgentChatProps {
  symbol: string;
  spotPrice: number;
  pcr?: number;
  vix?: number;
  sentiment?: string;
}

// Quick prompts — the bot now answers trades (all indices), news,
// gap (Gift Nifty) and correlation (Nifty–Sensex).
const QUICK_ACTIONS: { label: string; icon: any; query: string | ((symbol: string) => string) }[] = [
  { label: "NIFTY", icon: Bot, query: "NIFTY option trade now" },
  { label: "BANKNIFTY", icon: Bot, query: "BANKNIFTY option trade now" },
  { label: "FINNIFTY", icon: Bot, query: "FINNIFTY option trade now" },
  { label: "SENSEX", icon: Bot, query: "SENSEX option trade now" },
  { label: "News", icon: Newspaper, query: "What's the market news and sentiment right now?" },
  { label: "Gap", icon: TrendingUp, query: (s) => `What is the institutional gap prediction for ${s} for tomorrow's open?` },
  { label: "FII/DII", icon: Building2, query: "What is today's FII and DII cash flow?" },
  { label: "Scanner", icon: Scan, query: "Show me today's stock scanner picks" },
  { label: "Breakout", icon: Activity, query: (s) => `What are the breakout signals for ${s}?` },
  { label: "BTST", icon: Moon, query: "What are today's BTST picks?" },
  { label: "My Trades", icon: ClipboardList, query: "What trades did we generate today?" },
  { label: "Correlation", icon: Link2, query: "Nifty vs Sensex correlation signal?" },
  { label: "बताओ", icon: Bot, query: "mujhe ek trade do" },
];

// ─── Markdown (lightweight, escaped) ─────────────────────────────
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

// ─── Trade Alert Card ─────────────────────────────────────────────
function TradeCard({ alert }: { alert: TradeAlert }) {
  const isBuy = alert.side.toUpperCase().includes("BUY");
  const confColor = alert.confidence >= 85 ? "bg-emerald-500" : alert.confidence >= 70 ? "bg-amber-500" : "bg-red-500";
  const entryVal = alert.entry;
  const slVal = alert.sl;
  const tp1Val = alert.tp1;
  const riskPct = entryVal && slVal ? Math.abs((entryVal - slVal) / entryVal * 100).toFixed(1) : "—";
  const rewardPct = entryVal && tp1Val ? Math.abs((tp1Val - entryVal) / entryVal * 100).toFixed(1) : "—";
  const reasons = alert.rationale.split("·").map((r) => r.trim()).filter(Boolean);

  return (
    <div className="bg-card border border-border/60 rounded-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`h-6 px-2 rounded-md flex items-center gap-1 text-xs font-bold text-white ${isBuy ? "bg-emerald-600" : "bg-red-600"}`}>
            {isBuy ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            {alert.side}
          </div>
          <span className="text-xs font-mono font-bold">{alert.instrument}</span>
        </div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
          isBuy ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
        }`}>
          {alert.kind === "option" ? "OPTION" : "EQUITY"}
        </span>
      </div>

      {alert.expiry && (
        <p className="text-[9px] text-muted-foreground">Expiry: {alert.expiry}</p>
      )}

      <div className="grid grid-cols-4 gap-1 text-center">
        <div className="bg-muted/30 rounded-lg p-1.5">
          <p className="text-[8px] text-muted-foreground">ENTRY</p>
          <p className="text-xs font-bold font-mono text-foreground">₹{alert.entry.toFixed(2)}</p>
        </div>
        <div className="bg-red-500/5 rounded-lg p-1.5 border border-red-500/10">
          <p className="text-[8px] text-red-400">SL</p>
          <p className="text-xs font-bold font-mono text-red-400">₹{alert.sl.toFixed(2)}</p>
          <p className="text-[7px] text-red-400/60">-{riskPct}%</p>
        </div>
        <div className="bg-emerald-500/5 rounded-lg p-1.5 border border-emerald-500/10">
          <p className="text-[8px] text-emerald-400">TP1</p>
          <p className="text-xs font-bold font-mono text-emerald-400">₹{alert.tp1.toFixed(2)}</p>
          <p className="text-[7px] text-emerald-400/60">+{rewardPct}%</p>
        </div>
        <div className="bg-muted/30 rounded-lg p-1.5">
          <p className="text-[8px] text-muted-foreground">TP2 / R:R</p>
          <p className="text-xs font-bold font-mono text-foreground">₹{alert.tp2.toFixed(2)}</p>
          <p className="text-[7px] text-muted-foreground">1:{alert.rr}</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all ${confColor}`} style={{ width: `${alert.confidence || 0}%` }} />
        </div>
        <span className={`text-[10px] font-bold font-mono ${confColor.replace("bg-", "text-")}`}>
          {alert.confidence || 0}%
        </span>
      </div>

      {reasons.length > 0 && (
        <div className="space-y-0.5">
          {reasons.slice(0, 3).map((r, i) => (
            <p key={i} className="text-[10px] text-muted-foreground">→ {r}</p>
          ))}
        </div>
      )}
    </div>
  );
}

type VoiceMode = "off" | "listening" | "thinking" | "speaking";

export function AgentChat({ symbol, spotPrice, pcr, vix, sentiment }: AgentChatProps) {
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
  const abortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);
  const voiceSentRef = useRef(false);
  const typingRef = useRef(false);

  useEffect(() => { voiceModeRef.current = voiceMode; }, [voiceMode]);

  // Speech recognition + TTS
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      setSpeechSupported(true);
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-IN";
      recognition.maxAlternatives = 1;

      // Send as soon as a final utterance is captured — don't wait for
      // onend (in continuous mode Chrome often never fires it).
      recognition.onresult = (event: any) => {
        if (typingRef.current) return; // don't clobber what the user is typing
        let interim = "";
        let finalText = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) finalText += res[0].transcript;
          else interim += res[0].transcript;
        }
        const full = (finalText || interim).trim();
        pendingSpeechRef.current = full;
        setInput(full);
        if (finalText.trim() && !voiceSentRef.current) {
          voiceSentRef.current = true;
          pendingSpeechRef.current = "";
          try { recognition.stop(); } catch {}
          setVoiceMode("thinking");
          sendVoiceMessage(finalText.trim());
        }
      };

      recognition.onend = () => {
        voiceSentRef.current = false;
        if (voiceModeRef.current === "listening") {
          const text = pendingSpeechRef.current.trim();
          pendingSpeechRef.current = "";
          if (text && !voiceSentRef.current) {
            setVoiceMode("thinking");
            sendVoiceMessage(text);
          } else if (voiceModeRef.current === "listening") {
            try { recognition.start(); } catch {}
          }
        }
      };

      recognition.onerror = (event: any) => {
        const err = event?.error;
        if (err === "no-speech" || err === "aborted") {
          if (voiceModeRef.current === "listening") { try { recognition.start(); } catch {} }
          return;
        }
        if (err === "not-allowed" || err === "service-not-allowed") {
          setMicError("Mic blocked — allow microphone access in the browser");
        } else if (err === "audio-capture") {
          setMicError("No microphone found");
        } else {
          setMicError("Mic issue — tap the mic to retry");
        }
        setVoiceMode("off");
        setTimeout(() => setMicError(""), 4000);
      };

      recognitionRef.current = recognition;
    }
    if (window.speechSynthesis) setTtsSupported(true);
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  // Welcome
  useEffect(() => {
    if (messages.length === 0) {
      const sEmoji = sentiment === "bullish" ? "🟢" : sentiment === "bearish" ? "🔴" : "🟡";
      setMessages([
        {
          id: "welcome",
          role: "agent",
          content: `hey sachin! 👋 i'm SDM, your trading buddy.\n\n${sEmoji} **${symbol}** is at ₹${spotPrice.toLocaleString("en-IN")}${pcr ? ` — PCR ${pcr.toFixed(2)}` : ""}\n\nask me for a **trade** (Nifty/BankNifty/FinNifty/Sensex), **news**, **gap** (Gift Nifty) or **correlation**. बोलो "mujhe ek trade do" — i got hindi too! 🇮🇳`,
          timestamp: new Date(),
        },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const speakChunks = (text: string, voice: SpeechSynthesisVoice | null, onDone: () => void) => {
    const raw = text.replace(/[*#`]/g, "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    const sentences = raw.match(/[^.!?]+[.!?]+\s*/g) || [raw];
    const chunks: string[] = [];
    let buf = "";
    for (const s of sentences) {
      if (buf.length + s.length > 200) { if (buf) chunks.push(buf); buf = s; }
      else buf += s;
    }
    if (buf) chunks.push(buf);
    if (chunks.length === 0) { onDone(); return; }

    let idx = 0;
    const speakNext = () => {
      if (idx >= chunks.length) { onDone(); return; }
      const utt = new SpeechSynthesisUtterance(chunks[idx]);
      utt.lang = "en-IN"; utt.rate = 0.95; utt.pitch = 1.0; utt.volume = 1.0;
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
      || voices.find(v => v.lang === "en-IN")
      || voices.find(v => v.lang.startsWith("en"));
    setVoiceMode("speaking");
    const cleanup = () => {
      voiceSentRef.current = false;
      if (voiceModeRef.current !== "off") {
        setVoiceMode("listening");
        pendingSpeechRef.current = "";
        try { recognitionRef.current?.start(); } catch {}
      }
    };
    const safetyTimeout = setTimeout(() => { window.speechSynthesis.cancel(); cleanup(); }, 30000);
    speakChunks(text, natural || null, () => { clearTimeout(safetyTimeout); cleanup(); });
  };

  const callSDM = async (query: string, signal?: AbortSignal): Promise<SDMResponse> => {
    const res = await fetch("/api/sdm-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: query, symbol }),
      signal,
    });
    if (!res.ok) throw new Error("request_failed");
    const data = await res.json();
    return {
      text: data.text || "Sorry, I couldn't process that.",
      language: data.language || "en",
      alert: data.alert ?? null,
    };
  };

  const runQuery = async (query: string) => {
    if (!query.trim() || loading) return;
    // A text send must never leave voice mode stuck on.
    if (voiceModeRef.current !== "off") {
      try { recognitionRef.current?.stop(); } catch {}
      window.speechSynthesis?.cancel();
      setVoiceMode("off");
    }
    userStoppedRef.current = false;
    const userMsg: Message = { id: `u-${Date.now()}`, role: "user", content: query.trim(), timestamp: new Date() };
    const loadingMsg: Message = { id: `a-${Date.now()}`, role: "agent", content: "", timestamp: new Date(), loading: true };
    setMessages((prev) => [...prev, userMsg, loadingMsg]);
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      const reply = await callSDM(query, controller.signal);
      clearTimeout(timeout);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id ? { ...m, loading: false, content: reply.text, alert: reply.alert, language: reply.language } : m
        )
      );
      setLoading(false);
      abortRef.current = null;
      speakAndListen(reply.text);
    } catch (err: any) {
      clearTimeout(timeout);
      abortRef.current = null;
      if (userStoppedRef.current) { userStoppedRef.current = false; setLoading(false); return; }
      const errorText = err.name === "AbortError"
        ? "⚠️ Request timed out. Market data API may be slow — try again."
        : "⚠️ Network error. Please try again.";
      setMessages((prev) => prev.map((m) => m.id === loadingMsg.id ? { ...m, loading: false, content: errorText } : m));
      setLoading(false);
      speakAndListen(errorText);
    }
  };

  const sendVoiceMessage = (q: string) => runQuery(q);
  const sendTextMessage = (q: string) => runQuery(q);

  const stopAgent = () => {
    userStoppedRef.current = true;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    window.speechSynthesis?.cancel();
    setLoading(false);
    setMessages((prev) => prev.map((m) => (m.loading ? { ...m, loading: false, content: "Stopped." } : m)));
  };

  const toggleVoice = () => {
    if (voiceMode === "off") {
      if (!speechSupported) {
        setMicError("Voice not supported here — open in Chrome/Edge over localhost");
        setTimeout(() => setMicError(""), 4000);
        return;
      }
      setVoiceMode("listening");
      pendingSpeechRef.current = "";
      voiceSentRef.current = false;
      try { recognitionRef.current?.start(); } catch {
        setMicError("Could not start mic"); setVoiceMode("off");
        setTimeout(() => setMicError(""), 3000);
      }
    } else {
      setVoiceMode("off");
      window.speechSynthesis?.cancel();
      try { recognitionRef.current?.stop(); } catch {}
    }
  };

  const moodLabel = pcr == null ? "—" : pcr > 1.1 ? "Bullish PCR" : pcr < 0.9 ? "Bearish PCR" : "Neutral PCR";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 shrink-0">
        <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-500 to-cyan-600 flex items-center justify-center shadow-md">
          <Bot className="h-4 w-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold">SDM <span className="text-[8px] text-emerald-400 font-normal">Trading AI</span></p>
          <p className="text-[9px] text-muted-foreground truncate">
            {symbol} • ₹{spotPrice.toLocaleString("en-IN")}
            {pcr != null && <> • PCR {pcr.toFixed(2)}</>}
            {vix != null && <> • VIX {vix.toFixed(1)}</>}
          </p>
        </div>
        {voiceMode !== "off" ? (
          <Badge variant="outline" className={`text-[8px] border-0 text-white animate-pulse ${
            voiceMode === "listening" ? "bg-red-500" : voiceMode === "thinking" ? "bg-amber-500" : "bg-emerald-500"
          }`}>
            {voiceMode === "listening" && "🎤 Listening"}
            {voiceMode === "thinking" && "🧠 Thinking"}
            {voiceMode === "speaking" && "🔊 Speaking"}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[8px] bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
            LIVE
          </Badge>
        )}
      </div>

      {/* Mood strip */}
      <div className="px-3 py-1 border-b border-border/40 shrink-0 flex items-center gap-2 text-[9px] text-muted-foreground">
        <TrendingUp className="h-3 w-3 text-emerald-400" />
        <span>{moodLabel}</span>
        {sentiment && <span className="ml-auto capitalize">{sentiment}</span>}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div ref={scrollRef} className="p-3 space-y-3">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[92%] rounded-xl px-3 py-2 ${
                msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-card border border-border/50"
              }`}>
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
                    {msg.alert ? (
                      <TradeCard alert={msg.alert} />
                    ) : (
                      <div
                        className="text-[11px] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                      />
                    )}
                    {msg.role === "agent" && ttsSupported && voiceMode === "off" && !msg.alert && (
                      <button
                        onClick={() => {
                          const clean = msg.content.replace(/[*#`]/g, "").replace(/\n+/g, ". ");
                          const utter = new SpeechSynthesisUtterance(clean);
                          utter.lang = "en-IN"; utter.rate = 0.9;
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

      {/* Quick actions */}
      {voiceMode === "off" && (
        <div className="px-2 py-1.5 border-t border-border/50 shrink-0 overflow-x-auto">
          <div className="flex items-center gap-1">
            {QUICK_ACTIONS.map((qa) => (
              <Button
                key={qa.label}
                variant="ghost"
                size="sm"
                className="h-6 text-[9px] px-1.5 shrink-0 gap-0.5 text-muted-foreground hover:text-foreground"
                onClick={() => sendTextMessage(typeof qa.query === "function" ? qa.query(symbol) : qa.query)}
                disabled={loading}
              >
                <qa.icon className="h-2.5 w-2.5" />
                {qa.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Voice indicator */}
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
          <div className="text-[9px] text-yellow-500 mb-1">Voice not supported — use Chrome or Edge</div>
        )}
        <form
          onSubmit={(e) => { e.preventDefault(); sendTextMessage(input); }}
          className={`flex items-center gap-2 ${loading ? "agent-loading" : ""}`}
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => {
              typingRef.current = true;
              if (voiceMode !== "off") toggleVoice();
              setInput(e.target.value);
            }}
            onFocus={() => { typingRef.current = true; if (voiceMode !== "off") toggleVoice(); }}
            onBlur={() => { typingRef.current = false; }}
            placeholder={loading ? "SDM is thinking..." : voiceMode === "listening" ? "🎤 Listening..." : "Ask for a trade, news, gap or correlation..."}
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
