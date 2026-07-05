// Agent Chat — AI-powered trading assistant (ChatGPT-style)

"use client";

import { useState, useRef, useEffect } from "react";
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
  BookOpen,
  HelpCircle,
  Lightbulb,
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
  { label: "Market", icon: TrendingUp, query: "Analyze market structure — trend, S/R, VWAP" },
  { label: "Greeks", icon: Activity, query: "What's the Greeks analysis?" },
  { label: "OI", icon: BarChart3, query: "OI buildup patterns — long/short, PCR" },
  { label: "Entry", icon: Zap, query: "Should I enter a trade now?" },
  { label: "Risk", icon: Shield, query: "Check my risk — position sizing" },
  { label: "0DTE", icon: Clock, query: "Any 0DTE expiry setup?" },
];

const LEARN_ACTIONS = [
  { label: "What is CE/PE?", query: "Explain Call and Put options like I'm 5 years old" },
  { label: "What is Delta?", query: "Explain Delta, Gamma, Theta, Vega simply" },
  { label: "Straddle?", query: "What is a straddle and when to use it?" },
  { label: "Iron Condor?", query: "Explain Iron Condor strategy" },
  { label: "Stop Loss?", query: "How to set stop loss for options?" },
  { label: "Position Size?", query: "How to calculate position size?" },
  { label: "Best Strategy?", query: "Which strategy should I use in this market?" },
  { label: "Is this gambling?", query: "Is options trading gambling?" },
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
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-foreground">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-[11px] font-mono">$1</code>')
    .replace(/^• (.*$)/gm, '<span class="flex gap-1"><span class="text-primary">•</span><span>$1</span></span>')
    .replace(/^─{3,}$/gm, '<hr class="border-border my-2" />')
    .replace(/^(#{1,3}) (.*$)/gm, (_, hashes, title) => `<div class="font-bold text-sm mt-2 mb-1">${title}</div>`)
    .replace(/\n{2,}/g, '<div class="h-2" />')
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
  const [showLearn, setShowLearn] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (messages.length === 0) {
      const sentiment = analysis?.sentiment || "neutral";
      const sEmoji = sentiment === "bullish" ? "🟢" : sentiment === "bearish" ? "🔴" : "🟡";
      setMessages([
        {
          id: "welcome",
          role: "agent",
          content: `**Welcome! I'm Angel — Your ORCA Trading AI.** 🧠

${sEmoji} **${symbol}** ₹${spotPrice.toLocaleString("en-IN")} | PCR ${analysis?.pcr?.toFixed(2) || "—"}

I know EVERYTHING about options trading. Ask me anything:

**📊 Live Market Analysis**
• "ORCA Signal" — Full institutional trade signal
• "Best Trade" — Top recommendation right now
• "Market Structure" — Trend, support/resistance
• "Greeks" — Delta, Gamma, Theta, Vega analysis

**📚 Learn Trading (Ask Like You're 5)**
• "What is a Call option?"
• "Explain Delta simply"
• "Which strategy for this market?"
• "How to set stop loss?"

**🎯 Strategy & Risk**
• "Position sizing for ₹1L capital"
• "Iron Condor explained"
• "Is this a good trade?"

I never force trades. Capital preservation first. Ask me anything! 💡`,
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
        <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-md">
          <Bot className="h-4 w-4 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold">Angel <span className="text-[8px] text-violet-400 font-normal">AI</span></p>
          <p className="text-[9px] text-muted-foreground">
            {symbol} ₹{spotPrice.toLocaleString("en-IN")} • Ask me anything about trading
          </p>
        </div>
        <Badge variant="outline" className="text-[8px] bg-violet-500/10 text-violet-500 border-violet-500/20">
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
                    ? "bg-violet-600 text-white"
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
                    Thinking...
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
      <div className="px-2 py-1.5 border-t border-border/50 shrink-0">
        <div className="flex items-center gap-1 mb-1">
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 text-[9px] px-1.5 gap-0.5 ${!showLearn ? 'text-violet-500' : 'text-muted-foreground'}`}
            onClick={() => setShowLearn(false)}
          >
            <Zap className="h-2.5 w-2.5" /> Trade
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`h-6 text-[9px] px-1.5 gap-0.5 ${showLearn ? 'text-violet-500' : 'text-muted-foreground'}`}
            onClick={() => setShowLearn(true)}
          >
            <BookOpen className="h-2.5 w-2.5" /> Learn
          </Button>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto">
          {(showLearn ? LEARN_ACTIONS : QUICK_ACTIONS).map((qa) => (
            <Button
              key={qa.label}
              variant="ghost"
              size="sm"
              className="h-6 text-[9px] px-1.5 shrink-0 gap-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => sendMessage(qa.query)}
              disabled={loading}
            >
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
            placeholder="Ask anything about trading..."
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
