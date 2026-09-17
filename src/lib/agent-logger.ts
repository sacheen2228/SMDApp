// Agent Logger — observability for Hermes Agent
// Logs tool calls, LLM calls, errors, performance metrics.
// Append-only JSONL files for easy analysis.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const LOG_DIR = join(process.cwd(), "data", "agent-logs");

function ensureDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function logAppend(file: string, entry: Record<string, unknown>) {
  ensureDir();
  const line = JSON.stringify({ ...entry, _ts: new Date().toISOString() });
  appendFileSync(join(LOG_DIR, file), line + "\n");
}

// ─── Tool Call Logging ───
export interface ToolCallLog {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  success: boolean;
  durationMs: number;
  iteration: number;
  conversationId?: string;
}

export function logToolCall(call: ToolCallLog) {
  logAppend("tool-calls.jsonl", {
    type: "tool_call",
    ...call,
    outputLength: call.output.length,
  });
}

// ─── LLM Call Logging ───
export interface LLMCallLog {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  toolCount: number;
  toolNames: string[];
  conversationId?: string;
}

export function logLLMCall(call: LLMCallLog) {
  logAppend("llm-calls.jsonl", {
    type: "llm_call",
    ...call,
  });
}

// ─── Error Logging ───
export interface AgentErrorLog {
  context: string;
  error: string;
  stack?: string;
  conversationId?: string;
}

export function logAgentError(err: AgentErrorLog) {
  logAppend("errors.jsonl", {
    type: "error",
    ...err,
  });
}

// ─── Conversation Logging ───
export interface ConversationLog {
  conversationId: string;
  messageCount: number;
  toolCallCount: number;
  totalDurationMs: number;
  symbols: string[];
  actions: string[];
}

export function logConversation(log: ConversationLog) {
  logAppend("conversations.jsonl", {
    type: "conversation",
    ...log,
  });
}

// ─── Analytics ───
function readJsonl(file: string): Record<string, unknown>[] {
  const path = join(LOG_DIR, file);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line));
  } catch { return []; }
}

export function getToolCallStats(tool?: string): {
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  topTools: { name: string; count: number; successRate: number }[];
} {
  let calls = readJsonl("tool-calls.jsonl") as any[];
  if (tool) calls = calls.filter(c => c.tool === tool);
  
  const byTool = new Map<string, { total: number; success: number; duration: number }>();
  for (const c of calls) {
    const existing = byTool.get(c.tool) || { total: 0, success: 0, duration: 0 };
    existing.total += 1;
    if (c.success) existing.success += 1;
    existing.duration += c.durationMs || 0;
    byTool.set(c.tool, existing);
  }

  const topTools = Array.from(byTool.entries())
    .map(([name, s]) => ({ name, count: s.total, successRate: s.total > 0 ? s.success / s.total : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const totalCalls = calls.length;
  const successRate = totalCalls > 0 ? calls.filter(c => c.success).length / totalCalls : 0;
  const avgDurationMs = totalCalls > 0 ? calls.reduce((s, c) => s + (c.durationMs || 0), 0) / totalCalls : 0;

  return { totalCalls, successRate, avgDurationMs, topTools };
}

export function getLLMCallStats(): {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDurationMs: number;
  byProvider: { provider: string; count: number; avgTokens: number }[];
} {
  const calls = readJsonl("llm-calls.jsonl") as any[];
  const totalCalls = calls.length;
  const totalInputTokens = calls.reduce((s, c) => s + (c.inputTokens || 0), 0);
  const totalOutputTokens = calls.reduce((s, c) => s + (c.outputTokens || 0), 0);
  const avgDurationMs = totalCalls > 0 ? calls.reduce((s, c) => s + (c.durationMs || 0), 0) / totalCalls : 0;

  const byProviderMap = new Map<string, { count: number; tokens: number }>();
  for (const c of calls) {
    const existing = byProviderMap.get(c.provider) || { count: 0, tokens: 0 };
    existing.count += 1;
    existing.tokens += (c.inputTokens || 0) + (c.outputTokens || 0);
    byProviderMap.set(c.provider, existing);
  }
  const byProvider = Array.from(byProviderMap.entries())
    .map(([provider, s]) => ({ provider, count: s.count, avgTokens: s.count > 0 ? Math.round(s.tokens / s.count) : 0 }));

  return { totalCalls, totalInputTokens, totalOutputTokens, avgDurationMs, byProvider };
}

export function getErrorStats(): { total: number; recent: { context: string; error: string; ts: string }[] } {
  const errors = readJsonl("errors.jsonl") as any[];
  return {
    total: errors.length,
    recent: errors.slice(-10).reverse().map(e => ({ context: e.context, error: e.error, ts: e._ts })),
  };
}
