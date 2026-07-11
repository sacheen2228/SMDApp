// LLM Client — Groq (fast+free) → OpenRouter → Nvidia → Ollama
// Supports native tool calling for all providers

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const OLLAMA_URL = "http://localhost:11434/api/chat";

// Model configs
const GROQ_MODEL = "llama-3.3-70b-versatile";      // 32K context
const GROQ_FAST_MODEL = "llama-3.1-8b-instant";    // 8K context, 6000/min
const NVIDIA_MODEL = "meta/llama-3.1-405b-instruct";  // Nvidia's flagship
const OLLAMA_MODEL = "qwen2.5-coder:3b";

type Provider = "groq" | "openrouter" | "nvidia" | "ollama";

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string; };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

interface InternalTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

async function callAPI(
  url: string,
  apiKey: string,
  messages: LLMMessage[],
  model: string,
  timeout: number,
  tools?: InternalTool[],
  provider?: Provider
): Promise<LLMResponse> {
  const isOllama = provider === "ollama";

  const body: any = {
    model,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    stream: false,
    temperature: 0.2,
  };

  if (tools && tools.length > 0) {
    if (isOllama) {
      body.tools = tools;
    } else {
      body.tools = tools;
      body.tool_choice = "auto";
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "http://localhost:3000";
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    const error = new Error(`${res.status}: ${err.substring(0, 100)}`);
    (error as any).status = res.status;
    throw error;
  }

  const data = await res.json();

  if (isOllama) {
    const msg = data.message || {};
    return {
      content: msg.content || null,
      toolCalls: (msg.tool_calls || []).map((tc: any, i: number) => ({
        id: tc.id || `call_${i}`,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments),
        },
      })),
      model,
      usage: { promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0 },
    };
  } else {
    const choice = data.choices?.[0];
    const msg = choice?.message || {};
    return {
      content: msg.content || null,
      toolCalls: (msg.tool_calls || []).map((tc: any) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
      model,
      usage: { promptTokens: data.usage?.prompt_tokens || 0, completionTokens: data.usage?.completion_tokens || 0 },
    };
  }
}

export async function callLLM(messages: LLMMessage[], tools?: any[], model?: string): Promise<LLMResponse> {
  const groqKey = process.env.GROQ_API_KEY || "";
  const orKey = process.env.OPENROUTER_API_KEY || "";

  const internalTools: InternalTool[] = (tools || []).map((t: any) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));

  // Truncate long system prompts — keep market data section intact
  const msgs = messages.map((m) => {
    if (m.role === "system" && m.content?.length > 12000) {
      return { ...m, content: m.content.substring(0, 8000) + "\n\n[...truncated middle section...]\n\n" + m.content.substring(m.content.length - 4000) };
    }
    return m;
  });

  // 1. Groq (fast + free) — 70b has 32K context
  if (groqKey) {
    let all413 = true;
    for (const m of [GROQ_MODEL, GROQ_FAST_MODEL]) {
      try {
        console.log(`[LLM] Groq: ${m}`);
        const r = await callAPI(GROQ_URL, groqKey, msgs, m, 15000, internalTools, "groq");
        console.log(`[LLM] ✅ Groq ${m} OK`);
        return r;
      } catch (e: any) {
        console.warn(`[LLM] Groq ${m}: ${e.message}`);
        if (e.status !== 413) all413 = false;
        continue;
      }
    }
    if (all413) {
      console.warn(`[LLM] All Groq models rejected 413 — truncating system prompt`);
      const truncated = msgs.map((m) => {
        if (m.role === "system" && m.content?.length > 6000) {
          return { ...m, content: m.content.substring(0, 3000) + "\n\n...[truncated]...\n\n" + m.content.substring(m.content.length - 2000) };
        }
        return m;
      });
      try {
        const r = await callAPI(GROQ_URL, groqKey, truncated, GROQ_MODEL, 15000, internalTools, "groq");
        console.log(`[LLM] ✅ Groq (truncated) OK`);
        return r;
      } catch (e2: any) {
        console.warn(`[LLM] Groq truncated also failed: ${e2.message}`);
      }
    }
  }

  // 2. OpenRouter free — rate limited
  if (orKey) {
    for (const m of ["google/gemma-4-31b-it:free", "meta-llama/llama-3.3-70b-instruct:free"]) {
      try {
        console.log(`[LLM] OpenRouter: ${m}`);
        const r = await callAPI(OPENROUTER_URL, orKey, msgs, m, 15000, internalTools, "openrouter");
        console.log(`[LLM] ✅ OpenRouter ${m} OK`);
        return r;
      } catch (e: any) {
        console.warn(`[LLM] OpenRouter ${m}: ${e.message}`);
        continue;
      }
    }
  }

  // 3. Ollama local — native tool calling with /api/chat
  try {
    console.log(`[LLM] Ollama: ${OLLAMA_MODEL}`);
    const r = await callAPI(OLLAMA_URL, "", msgs, OLLAMA_MODEL, 45000, internalTools, "ollama");
    console.log(`[LLM] ✅ Ollama ${OLLAMA_MODEL} OK`);
    return r;
  } catch (e: any) {
    console.warn(`[LLM] Ollama ${OLLAMA_MODEL}: ${e.message}`);
  }

  throw new Error("All LLM providers failed");
}