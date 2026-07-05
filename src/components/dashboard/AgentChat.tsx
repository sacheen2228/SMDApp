// Agent Chat — AI-powered trading assistant (ChatGPT-style)

"use client";

import { useState, useRef, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Bot,
  Send,
  Zap,
  BookOpen,
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
  { label: "ORCA Signal", query: "Give me the ORCA live signal right now" },
  { label: "Best Trade", query: "What's the best trade right now?" },
  { label: "Market", query: "Analyze market structure" },
  { label: "Greeks", query: "What's the Greeks analysis?" },
  { label: "OI", query: "OI buildup patterns" },
  { label: "Entry", query: "Should I enter a trade now?" },
  { label: "Risk", query: "Check my risk" },
  { label: "0DTE", query: "Any 0DTE setup?" },
];

const LEARN_ACTIONS = [
  { label: "CE/PE?", query: "Explain Call and Put options simply" },
  { label: "Delta?", query: "Explain Delta, Gamma, Theta, Vega" },
  { label: "Straddle?", query: "What is a straddle?" },
  { label: "Iron Condor?", query: "Explain Iron Condor" },
  { label: "Stop Loss?", query: "How to set stop loss?" },
  { label: "Position?", query: "How to calculate position size?" },
  { label: "Strategy?", query: "Which strategy for this market?" },
  { label: "Gambling?", query: "Is options trading gambling?" },
];

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-foreground">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-[11px] font-mono">$1</code>')
    .replace(/^• (.*$)/gm, '<div class="flex gap-1"><span class="text-primary">•</span><span>$1</span></div>')
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
• "ORCA Signal" — Full trade signal
• "Best Trade" — Top recommendation
• "Greeks" — Delta, Gamma, Theta, Vega

**📚 Learn Trading**
• "What is a Call option?"
• "Explain Delta simply"
• "Which strategy for this market?"

I never force trades. Capital preservation first! 💡`,
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

  const actions = showLearn ? LEARN_ACTIONS : QUICK_ACTIONS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Bot style={{ width: 16, height: 16, color: 'white' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 12, fontWeight: 'bold', margin: 0 }}>Angel <span style={{ fontSize: 10, color: '#a78bfa' }}>AI</span></p>
          <p style={{ fontSize: 10, color: 'var(--muted-foreground)', margin: 0 }}>
            {symbol} ₹{spotPrice.toLocaleString("en-IN")} • Ask me anything
          </p>
        </div>
        <Badge variant="outline" style={{ fontSize: 8, background: 'rgba(139,92,246,0.1)', color: '#8b5cf6', borderColor: 'rgba(139,92,246,0.2)' }}>
          LIVE
        </Badge>
      </div>

      {/* Messages - scrollable area */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{ display: 'flex', justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}
          >
            <div
              style={{
                maxWidth: '90%',
                borderRadius: 12,
                padding: '8px 12px',
                background: msg.role === "user" ? '#7c3aed' : 'var(--card)',
                color: msg.role === "user" ? 'white' : 'inherit',
                border: msg.role === "user" ? 'none' : '1px solid var(--border)',
              }}
            >
              {msg.loading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--muted-foreground)' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8b5cf6', animation: 'bounce 1s infinite' }} />
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8b5cf6', animation: 'bounce 1s infinite 0.15s' }} />
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8b5cf6', animation: 'bounce 1s infinite 0.3s' }} />
                  </div>
                  Thinking...
                </div>
              ) : (
                <>
                  {msg.toolCallsMade && msg.toolCallsMade.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                      {msg.toolCallsMade.map((tc) => (
                        <span key={tc} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 8, background: 'rgba(139,92,246,0.1)', color: '#a78bfa', padding: '2px 6px', borderRadius: 4 }}>
                          <Zap style={{ width: 8, height: 8 }} />
                          {tc}
                        </span>
                      ))}
                    </div>
                  )}
                  <div
                    style={{ fontSize: 11, lineHeight: 1.6 }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                  />
                </>
              )}
              <p style={{ fontSize: 8, color: 'var(--muted-foreground)', marginTop: 4, opacity: 0.6 }}>
                {msg.timestamp.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Quick Actions - fixed at bottom */}
      <div style={{ flexShrink: 0, borderTop: '1px solid var(--border)', background: 'var(--card)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px 0' }}>
          <Button
            variant="ghost"
            size="sm"
            style={{ height: 20, fontSize: 9, padding: '0 6px', color: !showLearn ? '#8b5cf6' : 'var(--muted-foreground)' }}
            onClick={() => setShowLearn(false)}
          >
            <Zap style={{ width: 10, height: 10, marginRight: 2 }} /> Trade
          </Button>
          <Button
            variant="ghost"
            size="sm"
            style={{ height: 20, fontSize: 9, padding: '0 6px', color: showLearn ? '#8b5cf6' : 'var(--muted-foreground)' }}
            onClick={() => setShowLearn(true)}
          >
            <BookOpen style={{ width: 10, height: 10, marginRight: 2 }} /> Learn
          </Button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 6px', overflowX: 'auto' }}>
          {actions.map((qa) => (
            <Button
              key={qa.label}
              variant="ghost"
              size="sm"
              style={{ height: 20, fontSize: 9, padding: '0 6px', flexShrink: 0, color: 'var(--muted-foreground)' }}
              onClick={() => sendMessage(qa.query)}
              disabled={loading}
            >
              {qa.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Input - fixed at very bottom */}
      <div style={{ flexShrink: 0, padding: '8px 12px', borderTop: '1px solid var(--border)', background: 'var(--card)' }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage(input);
          }}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about trading..."
            style={{ height: 32, fontSize: 12 }}
            disabled={loading}
          />
          <Button
            type="submit"
            size="sm"
            style={{ height: 32, width: 32, padding: 0, flexShrink: 0, background: '#7c3aed', color: 'white' }}
            disabled={loading || !input.trim()}
          >
            <Send style={{ width: 14, height: 14 }} />
          </Button>
        </form>
      </div>
    </div>
  );
}
