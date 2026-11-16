/// NSE MCP Research Layer — Isolated HTTP Adapter
///
/// Implements the Streamable HTTP + JSON-RPC 2.0 protocol for NSE MCP.
/// ALL network activity is gated by independent permission checks.
/// Zero side-effects when disabled: no HTTP calls, no DB writes, no data flow.

import { McpFreshness, McpSource, McpReferenceQuote, McpBhavcopyEod, PriceComparisonTolerances } from "./mcp-types";
import { McpResearchGate, NseAuthorizationGate } from "./mcp-gates";

// ──────────────────────────────────────────────────────────────
// JSON-RPC 2.0 Types
// ──────────────────────────────────────────────────────────────

export interface McpRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: any;
}

export interface McpSuccessResponse<T = any> {
  jsonrpc: "2.0";
  id: string | number;
  result: T;
}

export interface McpErrorResponse {
  jsonrpc: "2.0";
  id: string | number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  status: number;
  statusText: string;
}

// ──────────────────────────────────────────────────────────────
// Request Timeout & Size Limits
// ──────────────────────────────────────────────────────────────

export const MCP_REQUEST_TIMEOUT_MS = 15_000; // 15 seconds max
export const MCP_MAX_RESPONSE_SIZE = 1_000_000; // 1MB max response body
export const MCP_MAX_RETRIES = 2; // bounded retries only (1 initial + 1 retry)
export const MCP_RETRY_DELAY_MS = 1_000; // 1s before retry

// ──────────────────────────────────────────────────────────────
// Circuit Breaker State
//──────────────────────────────────────────────────────────────

type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreaker {
  state: CircuitBreakerState;
  failures: number;
  lastFailure: number | null;
  openUntil: number | null;
}

const mcpCircuitBreaker: CircuitBreaker = {
  state: "CLOSED",
  failures: 0,
  lastFailure: null,
  openUntil: null,
};

function isCircuitOpen(): boolean {
  if (mcpCircuitBreaker.state === "CLOSED") return false;
  if (mcpCircuitBreaker.state === "OPEN") {
    if (mcpCircuitBreaker.openUntil !== null && Date.now() >= mcpCircuitBreaker.openUntil) {
      mcpCircuitBreaker.state = "HALF_OPEN";
      mcpCircuitBreaker.failures = 0;
      return false;
    }
    return true;
  }
  // HALF_OPEN — allow one test request
  return false;
}

function recordFailure(): void {
  mcpCircuitBreaker.failures++;
  mcpCircuitBreaker.lastFailure = Date.now();
  if (mcpCircuitBreaker.failures >= 3 && mcpCircuitBreaker.state !== "OPEN") {
    mcpCircuitBreaker.state = "OPEN";
    mcpCircuitBreaker.openUntil = Date.now() + 30_000; // 30s cooldown
  }
}

function recordSuccess(): void {
  mcpCircuitBreaker.failures = 0;
  mcpCircuitBreaker.state = "CLOSED";
  mcpCircuitBreaker.openUntil = null;
}

// ──────────────────────────────────────────────────────────────
// Core Fetch Function — gated by permission checks
// ──────────────────────────────────────────────────────────────

type FetchOptions = {
  timeoutMs?: number;
  baseUrl?: string;
  init?: RequestInit;
};

async function fetchMcp(
  endpoint: string,
  options: FetchOptions = {}
): Promise<McpResponse<any>> {
  // 1. GATE CHECK — fail-closed before ANY network activity
  // (Callers verify canFetchMcp() before calling this function)

  const timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
  const baseUrl = options.baseUrl ?? "https://mcp.nseindia.in";
  const url = new URL(endpoint, baseUrl).toString();

  // 2. Circuit breaker check
  if (isCircuitOpen()) {
    return {
      success: false,
      error: {
        code: -32000,
        message: "MCP circuit breaker open — too many consecutive failures",
      },
      status: 0,
      statusText: "Circuit Open",
    };
  }

  let aborter: AbortController | undefined;
  const timeoutId = setTimeout(() => {
    aborter?.abort();
  }, timeoutMs);

  try {
    const controller = new AbortController();
    aborter = controller;

    const fetchPromise = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "SMDApp-MCP-Research/1.0",
        ...(options.init?.headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "initialize",
        params: {
          timezone: "Asia/Kolkata",
          locale: "en-IN",
        },
      }),
      signal: controller.signal,
      ...(options.init ?? {}),
    });

    // Wait for fetch or timeout
    const response = await Promise.race([
      fetchPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("MCP request timeout")), timeoutMs);
      }),
    ]);

    clearTimeout(timeoutId);

    // 3. Response size limit
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MCP_MAX_RESPONSE_SIZE) {
      recordFailure();
      return {
        success: false,
        error: { code: -32000, message: "MCP response exceeds size limit", data: null },
        status: Number(contentLength) || 0,
        statusText: "Response Too Large",
      };
    }

    // 4. Parse status
    const status = response.status;
    const statusText = response.statusText;

    // 5. Try to parse JSON body
    let body: any = null;
    let parseError: string | null = null;

    try {
      const text = await response.text();
      if (text && text.trim().startsWith("{")) {
        body = JSON.parse(text);
      } else {
        throw new Error("Invalid JSON structure");
      }
    } catch (e: any) {
      parseError = e.message;
      body = null;
    }

    // 6. Handle HTTP error statuses
    let classifiedError: "BAD_REQUEST" | "AUTHENTICATION_ERROR" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMIT" | "SERVER_ERROR" | null = null;

    switch (status) {
      case 0:
        classifiedError = "SERVER_ERROR";
        break;
      case 400:
        classifiedError = "BAD_REQUEST";
        break;
      case 401:
        classifiedError = "AUTHENTICATION_ERROR";
        break;
      case 403:
        classifiedError = "FORBIDDEN";
        break;
      case 404:
        classifiedError = "NOT_FOUND";
        break;
      case 429:
        classifiedError = "RATE_LIMIT";
        break;
      default:
        if (status >= 500 && status < 600) {
          classifiedError = "SERVER_ERROR";
        }
    }

    // 7. If JSON-RPC error in body, override classification
    if (body && body.error) {
      const errCode = body.error.code;
      if (errCode === -32600) classifiedError = "BAD_REQUEST";
      else if (errCode === -32001) classifiedError = "BAD_REQUEST";
      else if (errCode === -32002) classifiedError = "BAD_REQUEST";
      else if (errCode === -32603) classifiedError = "SERVER_ERROR";
    }

    // 8. Circuit breaker updates
    if (classifiedError) {
      recordFailure();
    } else {
      recordSuccess();
    }

    // 9. Return structured result
    return {
      success: classifiedError === null,
      data: classifiedError ? undefined : body,
      error: classifiedError
        ? {
            code: classifiedError === "BAD_REQUEST" ? -32600 : -32000,
            message: classifiedError,
            data: body?.error?.data ?? null,
          }
        : undefined,
      status,
      statusText,
    };
  } catch (e: any) {
    clearTimeout(timeoutId);
    recordFailure();
    return {
      success: false,
      error: { code: -32000, message: e.message ?? "MCP fetch failed", data: null },
      status: 0,
      statusText: e.message ?? "MCP fetch error",
    };
  } finally {
    aborter?.abort();
  }
}

// ──────────────────────────────────────────────────────────────
// Gate-guarded Fetch Wrappers
// ──────────────────────────────────────────────────────────────

export function canFetchMcp(): boolean {
  return McpResearchGate.isEnabled() && NseAuthorizationGate.isAuthorized();
}

// Initialize MCP session (research-only)
export async function fetchInitialize(
  options: { timeoutMs?: number; baseUrl?: string } = {}
): Promise<{
  success: boolean;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  status: number;
  statusText: string;
  researchOnly: true;
}> {
  if (!canFetchMcp()) {
    return {
      success: false,
      error: { code: -32000, message: "MCP research disabled — gates not both true", data: null },
      status: 0,
      statusText: "MCP Disabled",
      researchOnly: true,
    };
  }

  // Bounded retry logic
  for (let attempt = 0; attempt <= MCP_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, MCP_RETRY_DELAY_MS));
    }

    const result = await fetchMcp("/jsonrpc", { timeoutMs: options.timeoutMs });

    if (result.success || result.status !== 0) {
      return {
        success: result.success,
        error: result.error,
        status: result.status,
        statusText: result.statusText,
        researchOnly: true,
      };
    }

    if (attempt < MCP_MAX_RETRIES) continue;
  }

  return {
    success: false,
    error: { code: -32000, message: "MCP initialize failed after retries", data: null },
    status: 0,
    statusText: "MCP Initialization Failed",
    researchOnly: true,
  };
}

// Tools list (discover available MCP tools)
export async function fetchToolsList(
  options: { timeoutMs?: number; baseUrl?: string } = {}
): Promise<{
  success: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: any;
  }>;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  status: number;
  statusText: string;
  researchOnly: true;
}> {
  if (!canFetchMcp()) {
    return {
      success: false,
      error: { code: -32000, message: "MCP research disabled — gates not both true", data: null },
      status: 0,
      statusText: "MCP Disabled",
      tools: [],
      researchOnly: true,
    };
  }

  const result = await fetchMcp("/jsonrpc", {
    timeoutMs: options.timeoutMs,
  });

  if (!result.success || result.status === 0) {
    return {
      success: false,
      error: result.error,
      status: result.status,
      statusText: result.statusText,
      tools: [],
      researchOnly: true,
    };
  }

  // Safely extract tools from response — never assume structure
  const tools: Array<{ name: string; description?: string; inputSchema?: any }> = [];

  if (result.data && Array.isArray((result.data as any).tools)) {
    const mcpTools = (result.data as any).tools;
    for (const tool of mcpTools) {
      tools.push({
        name: tool.name ?? "unknown",
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  return {
    success: true,
    tools,
    status: result.status,
    statusText: result.statusText,
    researchOnly: true,
  };
}

// Tools call (execute a specific MCP tool)
export async function fetchToolsCall(
  toolName: string,
  params: any,
  options: { timeoutMs?: number; baseUrl?: string } = {}
): Promise<{
  success: boolean;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  status: number;
  statusText: string;
  researchOnly: true;
}> {
  if (!canFetchMcp()) {
    return {
      success: false,
      error: { code: -32000, message: "MCP research disabled — gates not both true", data: null },
      status: 0,
      statusText: "MCP Disabled",
      researchOnly: true,
    };
  }

  if (!toolName || typeof toolName !== "string") {
    return {
      success: false,
      error: { code: -32602, message: "Invalid tool name", data: null },
      status: 0,
      statusText: "Invalid Tool Name",
      researchOnly: true,
    };
  }

  // Bounded retry
  for (let attempt = 0; attempt <= MCP_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, MCP_RETRY_DELAY_MS));
    }

    const result = await fetchMcp("/jsonrpc", {
      timeoutMs: options.timeoutMs,
    });

    if (!result.success || result.status === 0) {
      if (attempt < MCP_MAX_RETRIES) continue;
      return {
        success: false,
        error: result.error,
        status: result.status,
        statusText: result.statusText,
        researchOnly: true,
      };
    }

    // Return what we got — never assume MCP-specific result structure
    if (result.data && typeof result.data === "object") {
      return {
        success: true,
        result: result.data,
        status: result.status,
        statusText: result.statusText,
        researchOnly: true,
      };
    }

    if (attempt < MCP_MAX_RETRIES) continue;
  }

  return {
    success: false,
    error: {
      code: -32000,
      message: `MCP tool call "${toolName}" failed after retries`,
      data: null,
    },
    status: 0,
    statusText: "MCP Tool Call Failed",
    researchOnly: true,
  };
}

// ──────────────────────────────────────────────────────────────
// Health Check
// ──────────────────────────────────────────────────────────────

export async function getMcpHealth(): Promise<{
  status: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
  researchOnly: true;
  gates: {
    researchGate: boolean;
    authorizationGate: boolean;
  };
  circuitBreaker: {
    state: "CLOSED" | "OPEN" | "HALF_OPEN";
    failures: number;
  };
  lastError?: {
    code: number;
    message: string;
  };
  httpStatus: number | null;
  statusText: string | null;
}> {
  // Always report gate state — never makes HTTP calls when disabled
  return Promise.resolve({
    status: canFetchMcp() ? "HEALTHY" : "UNAVAILABLE",
    researchOnly: true,
    gates: {
      researchGate: McpResearchGate.isEnabled(),
      authorizationGate: NseAuthorizationGate.isAuthorized(),
    },
    circuitBreaker: {
      state: mcpCircuitBreaker.state,
      failures: mcpCircuitBreaker.failures,
    },
    lastError: undefined,
    httpStatus: null,
    statusText: null,
  });
}

// ──────────────────────────────────────────────────────────────
// Export Types for Test Usage
// ──────────────────────────────────────────────────────────────


