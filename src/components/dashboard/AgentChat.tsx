// Agent Chat — AI-powered trading assistant with live market data

"use client";

import { useState, useRef, useEffect, useMemo } from "react";
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
}

const QUICK_ACTIONS = [
  { label: "ORCA Signal", icon: Target, query: "Give me the ORCA live signal right now" },
  { label: "Best Trade", icon: Target, query: "What's the best trade right now?" },
  { label: "Market Structure", icon: TrendingUp, query: "Analyze market structure — trend, S/R, VWAP" },
  { label: "Greeks", icon: Activity, query: "What's the Greeks analysis? Delta, Gamma, Theta, Vega" },
  { label: "OI Analysis", icon: BarChart3, query: "OI buildup patterns — long/short, fresh writing, PCR" },
  { label: "Smart Money", icon: Brain, query: "Any smart money signals? Liquidity sweeps, fakeouts" },
  { label: "Entry Check", icon: Zap, query: "Should I enter a trade now? Check all entry conditions" },
  { label: "Risk Check", icon: Shield, query: "Check my risk — position sizing, max loss" },
  { label: "0DTE Setup", icon: Clock, query: "Any 0DTE expiry setup?" },
  { label: "Scanner", icon: Zap, query: "Show me top scanner picks" },
];

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
          content: `**Welcome Sachin! I'm your Angel — ORCA Trading AI.**\n\n${sEmoji} **${symbol}** | Spot ₹${spotPrice.toLocaleString("en-IN")} | PCR ${analysis?.pcr?.toFixed(2) || "—"}\n\nI analyze live market data using institutional-grade modules:\n• Market Structure • Greeks • OI • Smart Money • Flow\n• Entry/Exit Conditions • Risk Engine • 0DTE Expiry\n\n**Quick Actions:**\n• "ORCA Signal" — Full institutional trade signal\n• "Best Trade" — Top recommendation\n• "Market Structure" — Trend & S/R analysis\n• "Greeks" — Delta/Gamma/Theta/Vega\n• "Entry Check" — Should you trade now?\n\nI never force a trade. Capital preservation first.`,
          timestamp: new Date(),
        },
      ]);
    }
  }, [analysis, symbol, spotPrice]);

  const sendMessage = async (query: string) => {
    if (!query.trim() || loading) return;

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
        }),
      });

      const data = await res.json();

      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, loading: false, content: data.response || "Sorry, I couldn't process that.", toolCallsMade: data.toolCallsMade || [] }
            : m
        )
      );
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === loadingMsg.id
            ? { ...m, loading: false, content: "⚠️ Network error. Please try again." }
            : m
        )
      );
    } finally {
      setLoading(false);
      inputRef.current?.focus();
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
          <p className="text-xs font-bold">Angel <span className="text-[8px] text-emerald-400 font-normal">ORCA</span></p>
          <p className="text-[9px] text-muted-foreground">
            {symbol} • {analysis?.sentiment?.toUpperCase() || "NEUTRAL"} • Spot ₹{spotPrice.toLocaleString("en-IN")}
          </p>
        </div>
        <Badge variant="outline" className="text-[8px] bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
          LIVE
        </Badge>
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
                    <div
                      className="text-[11px] leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                    />
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
      <div className="px-2 py-1.5 border-t border-border/50 shrink-0 overflow-x-auto">
        <div className="flex items-center gap-1">
          {QUICK_ACTIONS.map((qa) => (
            <Button
              key={qa.label}
              variant="ghost"
              size="sm"
              className="h-6 text-[9px] px-1.5 shrink-0 gap-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => sendMessage(qa.query)}
              disabled={loading}
            >
              <qa.icon className="h-2.5 w-2.5" />
              {qa.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-border/50 shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(input);
          }}
          className="flex items-center gap-2"
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about market, trades, levels..."
            className="h-8 text-xs"
            disabled={loading}
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 w-8 p-0 shrink-0 bg-violet-600 hover:bg-violet-700 text-white"
            disabled={loading || !input.trim()}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </form>
      </div>
    </div>
  );
}
