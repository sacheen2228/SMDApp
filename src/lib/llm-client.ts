// OpenRouter LLM Client
// Free models via openrouter.ai — no API key needed for free tier models

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Free models on OpenRouter (no API key required for some, or free tier)
const FREE_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-4-maverick:free",
  "deepseek/deepseek-r1-0528:free",
  "qwen/qwen3-235b-a22b:free",
];

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: LLMToolCall[];
  model: string;
  usage: { promptTokens: number; completionTokens: number };
}

export async function callLLM(
  messages: LLMMessage[],
  tools?: any[],
  model?: string
): Promise<LLMResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY || "";
  const selectedModel = model || FREE_MODELS[0];

  const body: any = {
    model: selectedModel,
    messages,
    max_tokens: 2048,
    temperature: 0.7,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "HTTP-Referer": "https://smdapp.local",
      "X-Title": "SDM Options Intelligence",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];

  return {
    content: choice?.message?.content || null,
    toolCalls: choice?.message?.tool_calls || [],
    model: data.model || selectedModel,
    usage: {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
    },
  };
}

export { FREE_MODELS };
