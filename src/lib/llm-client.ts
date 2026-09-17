// LLM Client — TokenRa → Groq → OpenRouter → Ollama → Pattern Matcher
// Circuit breaker, cooldown, env vars, error classification
// Supports native tool calling for all providers

import { providerHealth, type ProviderType, type ErrorClassification } from "./provider-health";

// ─── Configuration from env vars ─────────────────────────────────
function env(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

const CONFIG = {
  tokenra: {
    baseUrl: env("TOKENRA_BASE_URL", "https://tokenra.io/v1"),
    chatEndpoint: env("TOKENRA_CHAT_ENDPOINT", "https://tokenra.io/v1/chat/completions"),
    apiKey: env("TOKENRA_API_KEY"),
    models: env("TOKENRA_MODEL", "deepseek-v4.1-flash").split(","),
    fallbackModels: env("TOKENRA_FALLBACK_MODELS", "deepseek-v4-flash,qwen3.8-flash").split(","),
    timeout: parseInt(env("TOKENRA_TIMEOUT", "30000")),
  },
  groq: {
    baseUrl: env("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
    apiKey: env("GROQ_API_KEY"),
    models: env("GROQ_MODEL", "llama-3.3-70b-versatile").split(","),
    fallbackModels: env("GROQ_FALLBACK_MODELS", "llama-3.1-8b-instant").split(","),
    timeout: parseInt(env("GROQ_TIMEOUT", "15000")),
  },
  openrouter: {
    baseUrl: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    apiKey: env("OPENROUTER_API_KEY"),
    models: env("OPENROUTER_MODEL", "nvidia/nemotron-3-ultra-550b-a55b:free").split(","),
    fallbackModels: env("OPENROUTER_FALLBACK_MODELS",
      "nvidia/nemotron-3.5-lightning:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,meta-llama/llama-3.3-70b-instruct:free"
    ).split(","),
    timeout: parseInt(env("OPENROUTER_TIMEOUT", "20000")),
  },
  ollama: {
    baseUrl: env("OLLAMA_BASE_URL", "http://localhost:11434"),
    model: env("OLLAMA_MODEL", "qwen2.5:0.5b"),
    timeout: parseInt(env("OLLAMA_TIMEOUT", "60000")),
  },
};

type Provider = "tokenra" | "groq" | "openrouter" | "ollama";

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
  // Metadata
  provider?: Provider;
  fallbackUsed?: boolean;
  fallbackReason?: string;
  latencyMs?: number;
}

interface InternalTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

// ─── Core API call ──────────────────────────────────────────────
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
    body.tools = tools;
    if (!isOllama) body.tool_choice = "auto";
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (provider === "openrouter") headers["HTTP-Referer"] = "http://localhost:3000";

  const startTime = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    const error = new Error(`${res.status}: ${err.substring(0, 200)}`);
    (error as any).status = res.status;
    (error as any).body = err;
    (error as any).retryAfter = providerHealth.parseRetryAfter(res.headers);
    throw error;
  }

  const data = await res.json();
  const latencyMs = Date.now() - startTime;

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

// ─── Provider-specific call with health tracking ────────────────
async function callProvider(
  provider: Provider,
  messages: LLMMessage[],
  tools: InternalTool[],
): Promise<LLMResponse> {
  const startTime = Date.now();
  let lastError: any = null;

  switch (provider) {
    case "tokenra": {
      const allModels = [...CONFIG.tokenra.models, ...CONFIG.tokenra.fallbackModels];
      for (const m of allModels) {
        try {
          console.log(`[LLM] TokenRa: ${m}`);
          const r = await callAPI(
            CONFIG.tokenra.chatEndpoint,
            CONFIG.tokenra.apiKey,
            messages, m, CONFIG.tokenra.timeout,
            tools, "tokenra"
          );
          if (!r.content && (!r.toolCalls || r.toolCalls.length === 0)) {
            console.warn(`[LLM] TokenRa ${m}: empty content`);
            continue;
          }
          const latency = Date.now() - startTime;
          providerHealth.recordSuccess("tokenra", latency);
          console.log(`[LLM] ✅ TokenRa ${m} OK (${latency}ms)`);
          return { ...r, provider: "tokenra", latencyMs: latency };
        } catch (e: any) {
          lastError = e;
          const errorType = providerHealth.classifyError(e.status || 0, e.body || e.message || "");
          console.warn(`[LLM] TokenRa ${m}: ${e.message} [${errorType}]`);

          // For balance/auth/model errors, skip remaining models
          if (errorType === "BALANCE" || errorType === "AUTH" || errorType === "MODEL_NOT_FOUND") {
            if (errorType === "BALANCE") {
              providerHealth.recordFailure("tokenra", "BALANCE", "Insufficient balance");
              break; // Skip all TokenRa models
            }
            continue; // Try next model
          }
          // For rate limit, set cooldown
          if (errorType === "RATE_LIMIT") {
            const retryAfter = e.retryAfter || 30000;
            providerHealth.recordFailure("tokenra", "RATE_LIMIT", `Rate limited, retry after ${retryAfter}ms`);
            break;
          }
          continue; // Try next model on other errors
        }
      }
      // All TokenRa models failed
      if (!providerHealth.getHealth("tokenra").lastSuccessAt) {
        providerHealth.recordFailure("tokenra", "UNKNOWN", "All models failed");
      }
      break;
    }

    case "groq": {
      if (!CONFIG.groq.apiKey) break;
      const allModels = [...CONFIG.groq.models, ...CONFIG.groq.fallbackModels];
      let all413 = true;
      for (const m of allModels) {
        try {
          console.log(`[LLM] Groq: ${m}`);
          const r = await callAPI(
            `${CONFIG.groq.baseUrl}/chat/completions`,
            CONFIG.groq.apiKey,
            messages, m, CONFIG.groq.timeout,
            tools, "groq"
          );
          const latency = Date.now() - startTime;
          providerHealth.recordSuccess("groq", latency);
          console.log(`[LLM] ✅ Groq ${m} OK (${latency}ms)`);
          return { ...r, provider: "groq", latencyMs: latency };
        } catch (e: any) {
          lastError = e;
          const errorType = providerHealth.classifyError(e.status || 0, e.body || e.message || "");
          console.warn(`[LLM] Groq ${m}: ${e.message} [${errorType}]`);
          if (e.status !== 413) all413 = false;

          if (errorType === "MODEL_NOT_FOUND") continue;
          if (errorType === "RATE_LIMIT") {
            providerHealth.recordFailure("groq", "RATE_LIMIT", e.message);
            break;
          }
          if (errorType === "AUTH") {
            providerHealth.recordFailure("groq", "AUTH", e.message);
            break;
          }
        }
      }
      // Try truncated prompt on 413
      if (all413) {
        const truncated = messages.map((m) => {
          if (m.role === "system" && m.content?.length > 6000) {
            return { ...m, content: m.content.substring(0, 3000) + "\n\n...[truncated]...\n\n" + m.content.substring(m.content.length - 2000) };
          }
          return m;
        });
        try {
          console.log(`[LLM] Groq: retry with truncated prompt`);
          const r = await callAPI(
            `${CONFIG.groq.baseUrl}/chat/completions`,
            CONFIG.groq.apiKey,
            truncated, CONFIG.groq.models[0], CONFIG.groq.timeout,
            tools, "groq"
          );
          const latency = Date.now() - startTime;
          providerHealth.recordSuccess("groq", latency);
          console.log(`[LLM] ✅ Groq (truncated) OK (${latency}ms)`);
          return { ...r, provider: "groq", latencyMs: latency };
        } catch (e2: any) {
          console.warn(`[LLM] Groq truncated also failed: ${e2.message}`);
        }
      }
      providerHealth.recordFailure("groq", "UNKNOWN", "All models failed");
      break;
    }

    case "openrouter": {
      if (!CONFIG.openrouter.apiKey) break;
      const allModels = [...CONFIG.openrouter.models, ...CONFIG.openrouter.fallbackModels];
      for (const m of allModels) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`[LLM] OpenRouter: ${m} (attempt ${attempt})`);
            const r = await callAPI(
              `${CONFIG.openrouter.baseUrl}/chat/completions`,
              CONFIG.openrouter.apiKey,
              messages, m, CONFIG.openrouter.timeout,
              tools, "openrouter"
            );
            if (!r.content && (!r.toolCalls || r.toolCalls.length === 0)) {
              if (attempt < 2) {
                console.warn(`[LLM] OpenRouter ${m}: empty content, retrying...`);
                continue;
              }
            }
            const latency = Date.now() - startTime;
            providerHealth.recordSuccess("openrouter", latency);
            console.log(`[LLM] ✅ OpenRouter ${m} OK (${latency}ms)`);
            return { ...r, provider: "openrouter", latencyMs: latency };
          } catch (e: any) {
            lastError = e;
            const errorType = providerHealth.classifyError(e.status || 0, e.body || e.message || "");
            console.warn(`[LLM] OpenRouter ${m}: ${e.message} [${errorType}]`);

            if (errorType === "RATE_LIMIT") {
              const retryAfter = e.retryAfter || 60000;
              providerHealth.recordFailure("openrouter", "RATE_LIMIT", `Rate limited, retry after ${retryAfter}ms`);
              break; // Skip remaining models
            }
            if (errorType === "AUTH") {
              providerHealth.recordFailure("openrouter", "AUTH", e.message);
              break;
            }
            break; // Don't retry on other errors
          }
        }
        if (providerHealth.getHealth("openrouter").status === "rate_limited") break;
      }
      if (!providerHealth.getHealth("openrouter").lastSuccessAt) {
        providerHealth.recordFailure("openrouter", "UNKNOWN", "All models failed");
      }
      break;
    }

    case "ollama": {
      try {
        console.log(`[LLM] Ollama: ${CONFIG.ollama.model}`);
        const r = await callAPI(
          `${CONFIG.ollama.baseUrl}/api/chat`,
          "", messages, CONFIG.ollama.model, CONFIG.ollama.timeout,
          tools, "ollama"
        );
        const latency = Date.now() - startTime;
        providerHealth.recordSuccess("ollama", latency);
        console.log(`[LLM] ✅ Ollama ${CONFIG.ollama.model} OK (${latency}ms)`);
        return { ...r, provider: "ollama", latencyMs: latency };
      } catch (e: any) {
        lastError = e;
        const errorType = providerHealth.classifyError(0, e.message || "");
        console.warn(`[LLM] Ollama ${CONFIG.ollama.model}: ${e.message} [${errorType}]`);
        providerHealth.recordFailure("ollama", errorType === "NETWORK" ? "NETWORK" : "UNKNOWN", e.message);
      }
      break;
    }
  }

  throw lastError || new Error(`${provider} failed`);
}

// ─── Main entry point ───────────────────────────────────────────
export async function callLLM(messages: LLMMessage[], tools?: any[], model?: string): Promise<LLMResponse> {
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

  // Provider chain — skip unhealthy providers immediately
  // Groq first (direct API key), OpenRouter second, Ollama local fallback
  // TokenRa disabled — uses OpenCode Zen free models which only work inside OpenCode CLI
  const chain: Provider[] = ["groq", "openrouter", "ollama", "tokenra"];
  const providerLabels: Record<Provider, string> = {
    tokenra: "TokenRa",
    groq: "Groq",
    openrouter: "OpenRouter",
    ollama: "Ollama",
  };

  let lastFallbackReason = "";

  for (const provider of chain) {
    // Skip if provider should be skipped (cooldown, circuit breaker, etc.)
    if (providerHealth.shouldSkip(provider)) {
      const h = providerHealth.getHealth(provider);
      console.log(`[AI] ${providerLabels[provider]} SKIP (${h.status}, circuit: ${h.circuitState})`);
      lastFallbackReason = `${providerLabels[provider]} ${h.status}`;
      continue;
    }

    // Skip if not configured
    if (provider === "tokenra" && !CONFIG.tokenra.apiKey) {
      console.log(`[AI] ${providerLabels[provider]} SKIP (not configured)`);
      lastFallbackReason = "TokenRa not configured";
      continue;
    }
    if (provider === "groq" && !CONFIG.groq.apiKey) {
      console.log(`[AI] ${providerLabels[provider]} SKIP (not configured)`);
      lastFallbackReason = "Groq not configured";
      continue;
    }
    if (provider === "openrouter" && !CONFIG.openrouter.apiKey) {
      console.log(`[AI] ${providerLabels[provider]} SKIP (not configured)`);
      lastFallbackReason = "OpenRouter not configured";
      continue;
    }

    try {
      console.log(`[AI] Trying ${providerLabels[provider]}...`);
      const result = await callProvider(provider, msgs, internalTools);
      return {
        ...result,
        fallbackUsed: !!lastFallbackReason,
        fallbackReason: lastFallbackReason || undefined,
      };
    } catch (e: any) {
      console.warn(`[AI] ${providerLabels[provider]} failed: ${e.message}`);
      lastFallbackReason = `${providerLabels[provider]}: ${e.message}`;
      continue;
    }
  }

  // All providers failed — throw to trigger pattern matcher
  throw new Error("All LLM providers failed");
}

// ─── Health check for all providers ─────────────────────────────
export function getProviderHealth() {
  return providerHealth.exportHealth();
}

// ─── Reset provider (manual recovery) ───────────────────────────
export function resetProvider(provider: ProviderType) {
  providerHealth.resetProvider(provider);
}
