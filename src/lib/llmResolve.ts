// lib/llmResolve.ts
//
// LLM-based intent fallback. Only called from sdmChat.ts when the
// regex path in detectIntent() comes back "unknown" or the message
// looks like a follow-up referencing prior context (e.g. "same for
// banknifty", "aur uske baare mein"). Reads the last few turns and
// resolves what the user actually wants.
//
// Routed through the project's shared callLLM() provider chain
// (Groq -> OpenRouter -> Ollama) so it works with the keys already
// present in the environment — no separate Anthropic key required.

import { callLLM, type LLMMessage } from "./llm-client";
import type { ChatTurn } from "./sdmChat";

const VALID_KINDS = ["trade", "news", "gap", "correlation", "greeting", "unknown"] as const;
type Kind = (typeof VALID_KINDS)[number];

export interface LLMResolved {
  kind: Kind;
  symbol?: string;
}

const SYSTEM_PROMPT = `You are an intent classifier for a trading assistant bot called SDM.
Given the recent conversation and the user's latest message, classify the
intent as exactly one of: trade, news, gap, correlation, greeting, unknown.

- "trade": user wants a trade/option alert for an index or stock (e.g. Nifty, BankNifty, Sensex, or any equity symbol)
- "news": user wants market news / sentiment
- "gap": user is asking about Gift Nifty gap-up/gap-down
- "correlation": user is asking about Nifty-Sensex correlation
- "greeting": user is just saying hi
- "unknown": none of the above, or too unclear even with context

If a "trade" intent has an index or stock symbol implied by the recent
conversation (even if not restated in the latest message), extract it into
"symbol" using the same ticker style already used in the conversation
(e.g. "NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", or an equity
symbol). If no symbol can be resolved, omit "symbol" entirely.

Reply with JSON only. No preamble, no markdown fences. Examples:
{"kind":"trade","symbol":"BANKNIFTY"}
{"kind":"news"}`;

function historyToPrompt(history: ChatTurn[]): string {
  return history.map((t) => `${t.role === "user" ? "User" : "Bot"}: ${t.text}`).join("\n");
}

export async function llmResolveIntent(
  message: string,
  history: ChatTurn[]
): Promise<LLMResolved | null> {
  try {
    const conversationBlock = history.length
      ? `Recent conversation:\n${historyToPrompt(history)}\n\n`
      : "";

    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${conversationBlock}Latest message: "${message}"` },
    ];

    const data = await callLLM(messages);
    const rawText: string = data.content?.trim() ?? "";
    if (!rawText) return null;

    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!VALID_KINDS.includes(parsed.kind)) return null;

    return {
      kind: parsed.kind,
      symbol: typeof parsed.symbol === "string" ? parsed.symbol.toUpperCase() : undefined,
    };
  } catch {
    return null; // caller falls back to regex / last-turn heuristics
  }
}
