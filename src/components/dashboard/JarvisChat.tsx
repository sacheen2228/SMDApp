"use client";

// Jarvis chat — the chat-first surface of the Jarvis tab. Posts to
// POST /api/jarvis/chat (gate guard → classifier → single-shot LLM
// narration, no tools) and reveals the reply word-by-word for a live
// feel. The signal stays authoritative: the endpoint's diff backstop
// discards any reply that contradicts it, and the gate guard refuses
// bypass language deterministically before any LLM sees it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Bot,
  Send,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  MessageSquare,
} from "lucide-react";

interface JarvisChatProps {
  symbol: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "jarvis";
  content: string;
  loading?: boolean;
  route?: "guard" | "direct" | "open";
  backstop?: boolean;
}

interface ChatReply {
  response: string;
  route: "guard" | "direct" | "open";
  backstop?: boolean;
  jarvis?: { action: string; instrument: string; source: string; biasScore?: number };
}

const QUICK_PROMPTS = [
  { label: "Signal", query: "Jarvis signal" },
  { label: "Why blocked?", query: "Why is it blocked?" },
  { label: "Bias", query: "What's the bias?" },
  { label: "Entry / SL / TP", query: "Give me entry, stop loss and targets" },
  { label: "Why NO TRADE?", query: "Why no trade?" },
  { label: "Groups", query: "How many groups agree?" },
  { label: "Greeks", query: "What are the greeks saying?" },
];

const ROUTE_BADGE: Record<string, { label: string; cls: string }> = {
  guard: { label: "GATE GUARD", cls: "bg-amber-600/90 text-white" },
  direct: { label: "SIGNAL", cls: "bg-sky-600/90 text-white" },
  open: { label: "RESEARCH", cls: "bg-violet-600/90 text-white" },
};

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
    .replace(/`(.*?)`/g, '<code class="bg-muted px-1 rounded text-[11px]">$1</code>')
    .replace(/^• /gm, '<span class="text-sky-500 mr-1">•</span> ')
    .replace(/\n/g, "<br />");
}

export function JarvisChat({ symbol }: JarvisChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const revealRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      if (revealRef.current) window.clearInterval(revealRef.current);
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  // Word-by-word reveal — makes the reply feel live without a parallel
  // streaming path through the provider chain.
  const revealReply = useCallback(
    (msgId: string, full: string) => {
      const parts = full.split(/(\s+)/);
      let i = 0;
      if (revealRef.current) window.clearInterval(revealRef.current);
      revealRef.current = window.setInterval(() => {
        i += 2;
        const partial = parts.slice(0, i).join("");
        if (aliveRef.current) {
          setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, content: partial } : m)));
          scrollToBottom();
        }
        if (i >= parts.length) {
          if (revealRef.current) window.clearInterval(revealRef.current);
          revealRef.current = null;
        }
      }, 18);
    },
    [scrollToBottom]
  );

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || loading) return;
      setInput("");
      setError(null);
      setLoading(true);

      const userId = `u-${Date.now()}`;
      const botId = `a-${Date.now()}`;
      const history = messages
        .filter((m) => !m.loading && m.content)
        .slice(-8)
        .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

      setMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: q },
        { id: botId, role: "jarvis", content: "", loading: true },
      ]);
      scrollToBottom();

      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = window.setTimeout(() => controller.abort(), 60000);

      try {
        const res = await fetch("/api/jarvis/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: q, symbol, history }),
          signal: controller.signal,
        });
        window.clearTimeout(timeout);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data?.error || `http_${res.status}`);

        const reply: ChatReply = data;
        if (!aliveRef.current) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === botId
              ? { ...m, loading: false, route: reply.route, backstop: reply.backstop }
              : m
          )
        );
        setLoading(false);
        abortRef.current = null;
        revealReply(botId, reply.response || "No reply.");
      } catch (err: any) {
        window.clearTimeout(timeout);
        abortRef.current = null;
        if (!aliveRef.current) return;
        const errorText =
          err?.name === "AbortError"
            ? "⚠️ Jarvis took too long — try again."
            : `⚠️ ${err?.message || "Network error — try again."}`;
        setMessages((prev) => prev.map((m) => (m.id === botId ? { ...m, loading: false, content: errorText } : m)));
        setError(errorText);
        setLoading(false);
      }
    },
    [loading, messages, symbol, scrollToBottom, revealReply]
  );

  const clearChat = () => {
    if (revealRef.current) window.clearInterval(revealRef.current);
    revealRef.current = null;
    setMessages([]);
    setError(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header strip */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-border/50 shrink-0">
        <Badge className="bg-sky-600 text-white text-[9px]">
          <Bot className="h-2.5 w-2.5 mr-1" /> JARVIS
        </Badge>
        <Badge variant="outline" className="text-[9px]">{symbol}</Badge>
        <span className="text-[9px] text-muted-foreground">gate-guarded · signal-grounded · no tools</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[9px]" onClick={clearChat} disabled={loading}>
          <RefreshCw className="h-2.5 w-2.5 mr-1" /> New chat
        </Button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-2.5">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageSquare className="h-5 w-5 text-sky-500" />
            <div className="text-sm font-medium">Ask Jarvis anything about {symbol}</div>
            <div className="text-[10px] text-muted-foreground max-w-[340px]">
              Answers come from the live worker signal — gates, levels and bias are quoted, never
              invented. Beyond-signal questions get a fast opinion, but the signal always wins.
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[92%] rounded-xl px-3 py-2 ${
                msg.role === "user" ? "bg-sky-600 text-white" : "bg-card border border-border/50"
              }`}
            >
              {msg.loading ? (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="flex gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  Jarvis is thinking…
                </div>
              ) : (
                <>
                  {msg.role === "jarvis" && (
                    <div className="flex items-center gap-1 mb-1">
                      {msg.route && (
                        <Badge className={`${ROUTE_BADGE[msg.route].cls} text-[8px] px-1 py-0`}>
                          {ROUTE_BADGE[msg.route].label}
                        </Badge>
                      )}
                      {msg.backstop && (
                        <Badge className="bg-red-600/90 text-white text-[8px] px-1 py-0" title="Reply contradicted the live signal and was replaced by it.">
                          <ShieldAlert className="h-2 w-2 mr-0.5" /> BACKSTOP
                        </Badge>
                      )}
                    </div>
                  )}
                  <div
                    className="text-[11px] leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                  />
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Quick prompts */}
      <div className="px-2 py-1.5 border-t border-border/50 shrink-0 overflow-x-auto">
        <div className="flex items-center gap-1">
          <Sparkles className="h-2.5 w-2.5 text-sky-500 shrink-0" />
          {QUICK_PROMPTS.map((qp) => (
            <Button
              key={qp.label}
              variant="ghost"
              size="sm"
              className="h-6 text-[9px] px-1.5 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => send(qp.query)}
              disabled={loading}
            >
              {qp.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="px-2.5 py-2 border-t border-border/50 shrink-0">
        {error && (
          <div className="text-[9px] text-red-400 mb-1 flex items-center gap-1">
            <ShieldAlert className="h-2.5 w-2.5" /> {error}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex items-center gap-2"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={loading ? "Jarvis is thinking…" : `Ask Jarvis about ${symbol}…`}
            className="h-8 text-xs"
            disabled={loading}
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 w-8 p-0 shrink-0 bg-sky-600 hover:bg-sky-700 text-white"
            disabled={!input.trim() || loading}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </form>
        <div className="text-[8px] text-muted-foreground/70 mt-1">
          Educational only · Jarvis never overrides buildSignal() gates · no alert is ever sent from chat
        </div>
      </div>
    </div>
  );
}
