// Hermes Schema Validator — runtime validation for all market data
// TypeScript interfaces are NOT sufficient. Malformed HTTP 200 must be rejected.

// ── Types ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  normalizedData?: any;
}

export interface SpotPayload {
  symbol?: string;
  exchange?: string;
  price?: number;
  timestamp?: string;
  [key: string]: any;
}

export interface OptionStrikePayload {
  strike?: number;
  ltp?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  oi?: number;
  oiChange?: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  [key: string]: any;
}

export interface OptionChainPayload {
  expiry?: string;
  daysToExpiry?: number;
  atmStrike?: number;
  totalCallOI?: number;
  totalPutOI?: number;
  strikes?: any[];
  [key: string]: any;
}

// ── Helpers ───────────────────────────────────────────────────────────

function isFiniteNumber(val: any): val is number {
  return typeof val === "number" && Number.isFinite(val);
}

function isPositiveNumber(val: any): val is number {
  return isFiniteNumber(val) && val > 0;
}

function isNonNegativeNumber(val: any): val is number {
  return isFiniteNumber(val) && val >= 0;
}

function isValidTimestamp(val: any): val is string {
  if (typeof val !== "string") return false;
  const t = Date.parse(val);
  return !isNaN(t);
}

function isString(val: any): val is string {
  return typeof val === "string" && val.length > 0;
}

function isBoolean(val: any): val is boolean {
  return typeof val === "boolean";
}

// ── Spot Validation ───────────────────────────────────────────────────

export function validateSpot(data: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Spot data is not an object"], warnings: [] };
  }

  if (!isString(data.symbol)) {
    errors.push("Missing or empty symbol");
  }

  if (!isString(data.exchange)) {
    errors.push("Missing or empty exchange");
  }

  if (!isFiniteNumber(data.price)) {
    if (data.price === undefined || data.price === null) {
      errors.push("Missing price field");
    } else if (isNaN(data.price)) {
      errors.push("Price is NaN");
    } else if (!Number.isFinite(data.price)) {
      errors.push("Price is Infinity");
    } else {
      errors.push(`Price is not a number: ${typeof data.price}`);
    }
  } else if (data.price <= 0) {
    errors.push(`Price must be > 0, got ${data.price}`);
  } else if (data.price > 500000) {
    warnings.push(`Price ${data.price} seems abnormally high`);
  }

  if (data.timestamp !== undefined && data.timestamp !== null) {
    if (!isValidTimestamp(data.timestamp)) {
      errors.push(`Invalid timestamp: ${data.timestamp}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalizedData: errors.length === 0 ? {
      symbol: String(data.symbol),
      exchange: String(data.exchange),
      price: Number(data.price),
      timestamp: data.timestamp ? String(data.timestamp) : new Date().toISOString(),
    } : undefined,
  };
}

// ── Option Strike Validation ──────────────────────────────────────────

export function validateOptionStrike(data: any, strikeIndex?: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prefix = strikeIndex !== undefined ? `Strike[${strikeIndex}]` : "Strike";

  if (!data || typeof data !== "object") {
    return { valid: false, errors: [`${prefix}: not an object`], warnings: [] };
  }

  // Strike price
  if (!isPositiveNumber(data.strike)) {
    errors.push(`${prefix}: strike must be > 0`);
  }

  // LTP (premium)
  if (data.ltp !== undefined && data.ltp !== null) {
    if (!isNonNegativeNumber(data.ltp)) {
      errors.push(`${prefix}: ltp must be >= 0, got ${data.ltp}`);
    }
  }

  // Bid
  if (data.bid !== undefined && data.bid !== null) {
    if (!isNonNegativeNumber(data.bid)) {
      errors.push(`${prefix}: bid must be >= 0, got ${data.bid}`);
    }
  }

  // Ask
  if (data.ask !== undefined && data.ask !== null) {
    if (!isNonNegativeNumber(data.ask)) {
      errors.push(`${prefix}: ask must be >= 0, got ${data.ask}`);
    }
  }

  // Bid/Ask relationship
  if (isFiniteNumber(data.bid) && isFiniteNumber(data.ask)) {
    if (data.ask < data.bid) {
      errors.push(`${prefix}: ask (${data.ask}) < bid (${data.bid})`);
    }
  }

  // Volume
  if (data.volume !== undefined && data.volume !== null) {
    if (!isNonNegativeNumber(data.volume)) {
      errors.push(`${prefix}: volume must be >= 0, got ${data.volume}`);
    }
  }

  // OI
  if (data.oi !== undefined && data.oi !== null) {
    if (!isNonNegativeNumber(data.oi)) {
      errors.push(`${prefix}: oi must be >= 0, got ${data.oi}`);
    }
  }

  // OI Change (can be negative — unwinding)
  if (data.oiChange !== undefined && data.oiChange !== null) {
    if (!isFiniteNumber(data.oiChange)) {
      errors.push(`${prefix}: oiChange must be a finite number, got ${data.oiChange}`);
    }
  }

  // IV
  if (data.iv !== undefined && data.iv !== null) {
    if (!isNonNegativeNumber(data.iv)) {
      errors.push(`${prefix}: iv must be >= 0, got ${data.iv}`);
    } else if (data.iv > 200) {
      warnings.push(`${prefix}: iv ${data.iv}% seems abnormally high`);
    }
  }

  // Greeks — can be negative (theta, delta for puts)
  const greekFields = ["delta", "gamma", "theta", "vega", "rho"];
  for (const field of greekFields) {
    if (data[field] !== undefined && data[field] !== null) {
      if (!isFiniteNumber(data[field])) {
        errors.push(`${prefix}: ${field} must be a finite number, got ${data[field]}`);
      }
    }
  }

  // Gamma must be non-negative
  if (isFiniteNumber(data.gamma) && data.gamma < 0) {
    errors.push(`${prefix}: gamma must be >= 0, got ${data.gamma}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Option Chain Validation ───────────────────────────────────────────

export function validateOptionChain(data: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Option chain data is not an object"], warnings: [] };
  }

  // Required fields
  if (!isString(data.expiry)) {
    errors.push("Missing or empty expiry");
  }

  if (data.daysToExpiry !== undefined && data.daysToExpiry !== null) {
    if (!isFiniteNumber(data.daysToExpiry)) {
      errors.push(`daysToExpiry must be a number, got ${data.daysToExpiry}`);
    } else if (data.daysToExpiry < 0) {
      errors.push(`daysToExpiry must be >= 0, got ${data.daysToExpiry}`);
    }
  }

  if (!isPositiveNumber(data.atmStrike)) {
    errors.push("Missing or invalid atmStrike");
  }

  // Strikes array
  if (!Array.isArray(data.strikes)) {
    errors.push("Missing or non-array strikes");
  } else if (data.strikes.length === 0) {
    warnings.push("Empty strikes array");
  } else {
    // Validate each strike
    for (let i = 0; i < data.strikes.length; i++) {
      const strikeResult = validateOptionStrike(data.strikes[i], i);
      if (!strikeResult.valid) {
        errors.push(...strikeResult.errors);
      }
      warnings.push(...strikeResult.warnings);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ── Provider Response Validation ──────────────────────────────────────

export function validateProviderResponse(
  data: any,
  provider: string,
  expectedType: "spot" | "optionChain" | "ltp" | "generic"
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if data exists
  if (data === null || data === undefined) {
    return { valid: false, errors: [`${provider}: response is null/undefined`], warnings: [] };
  }

  // Check if it's an object (not a raw string/number)
  if (typeof data === "string") {
    // Some providers return HTML on error
    if (data.includes("<html") || data.includes("<!DOCTYPE") || data.includes("Welcome to")) {
      return { valid: false, errors: [`${provider}: received HTML instead of JSON`], warnings: [] };
    }
    return { valid: false, errors: [`${provider}: response is a string, not an object`], warnings: [] };
  }

  if (typeof data !== "object") {
    return { valid: false, errors: [`${provider}: unexpected response type: ${typeof data}`], warnings: [] };
  }

  // Check for common error patterns
  if (data.error || data.Error || data.ERROR) {
    const errMsg = data.error || data.Error || data.ERROR;
    if (typeof errMsg === "string" && errMsg.length > 0) {
      return { valid: false, errors: [`${provider}: error in response: ${errMsg}`], warnings: [] };
    }
  }

  if (data.status === "error" || data.status === "ERROR") {
    return { valid: false, errors: [`${provider}: status=error`], warnings: [] };
  }

  if (data.message && typeof data.message === "string" && data.message.includes("error")) {
    warnings.push(`${provider}: response contains error message`);
  }

  // Type-specific validation
  switch (expectedType) {
    case "spot": {
      const spotResult = validateSpot(data);
      if (!spotResult.valid) {
        errors.push(...spotResult.errors.map(e => `${provider}: ${e}`));
      }
      warnings.push(...spotResult.warnings.map(w => `${provider}: ${w}`));
      break;
    }
    case "optionChain": {
      const chainResult = validateOptionChain(data);
      if (!chainResult.valid) {
        errors.push(...chainResult.errors.map(e => `${provider}: ${e}`));
      }
      warnings.push(...chainResult.warnings.map(w => `${provider}: ${w}`));
      break;
    }
    case "ltp": {
      if (!isPositiveNumber(data) && !isPositiveNumber(data?.ltp) && !isPositiveNumber(data?.price)) {
        errors.push(`${provider}: no valid LTP/price in response`);
      }
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    normalizedData: errors.length === 0 ? data : undefined,
  };
}

// ── Convenience: validate and throw ───────────────────────────────────

export function validateOrReject(
  data: any,
  provider: string,
  expectedType: "spot" | "optionChain" | "ltp" | "generic"
): any {
  const result = validateProviderResponse(data, provider, expectedType);
  if (!result.valid) {
    throw new Error(`Invalid data from ${provider}: ${result.errors.join("; ")}`);
  }
  return result.normalizedData || data;
}
