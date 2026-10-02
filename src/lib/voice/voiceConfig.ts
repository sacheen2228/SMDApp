// Voice Configuration — spec §14.
// Base: process.env VOICE_* · Override: data/voice-config.json (UI-saved, wins).

import fs from "fs";
import path from "path";

export interface VoiceSettings {
  enabled: boolean;
  provider: "piper" | "kokoro" | "espeak";
  model: string;              // installed TTS voice (piper voice name)
  speed: number;              // 0.80 – 1.10 spoken rate
  volume: number;             // 0 – 1
  tradeAlerts: boolean;
  entryAlerts: boolean;
  tpAlerts: boolean;
  slAlerts: boolean;
  noTrade: boolean;
  marketBriefing: boolean;
  systemAlerts: boolean;
  telegramVoice: boolean;
  piperUrl: string;           // local piper HTTP sidecar
  modelDir: string;           // voice model dir
  audioDir: string;           // temp audio storage
  retentionMin: number;       // audio file retention
}

const PROVIDERS = ["piper", "kokoro", "espeak"] as const;

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return v === "true" || v === "1" || v === "yes";
}

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export function configFilePath(): string {
  return process.env.VOICE_CONFIG_FILE || path.join(process.cwd(), "data", "voice-config.json");
}

export function clampSpeed(n: number): number {
  if (!Number.isFinite(n)) return 0.95;
  return Math.min(1.1, Math.max(0.8, Math.round(n * 100) / 100));
}

export function clampVolume(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

function coerceProvider(v: unknown): VoiceSettings["provider"] {
  return (PROVIDERS as readonly string[]).includes(String(v)) ? (v as VoiceSettings["provider"]) : "piper";
}

function asBool(v: unknown, def: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return def;
}

export function defaultVoiceSettings(): VoiceSettings {
  return {
    enabled: envBool("VOICE_ENABLED", true),
    provider: coerceProvider(process.env.VOICE_PROVIDER || "piper"),
    model: process.env.VOICE_MODEL || "en_US-ryan-medium",
    speed: clampSpeed(envNum("VOICE_SPEED", 0.95)),
    volume: clampVolume(envNum("VOICE_VOLUME", 1.0)),
    tradeAlerts: envBool("VOICE_TRADE_ALERTS", true),
    entryAlerts: envBool("VOICE_ENTRY_ALERTS", true),
    tpAlerts: envBool("VOICE_TP_ALERTS", true),
    slAlerts: envBool("VOICE_SL_ALERTS", true),
    noTrade: envBool("VOICE_NO_TRADE", false),
    marketBriefing: envBool("VOICE_MARKET_BRIEFING", true),
    systemAlerts: envBool("VOICE_SYSTEM_ALERTS", true),
    telegramVoice: envBool("VOICE_TELEGRAM", true),
    piperUrl: process.env.VOICE_PIPER_URL || "http://127.0.0.1:5000",
    modelDir: process.env.VOICE_MODEL_DIR || path.join(process.cwd(), "voices"),
    audioDir: process.env.VOICE_AUDIO_DIR || "/tmp/smdapp-voice",
    retentionMin: envNum("VOICE_RETENTION_MIN", 120),
  };
}

/** Validate/coerce an arbitrary patch onto a full settings object. */
export function sanitizeSettings(patch: Record<string, any>, base: VoiceSettings): VoiceSettings {
  return {
    enabled: asBool(patch.enabled, base.enabled),
    provider: PROVIDERS.includes(patch.provider) ? patch.provider : base.provider,
    model: typeof patch.model === "string" && patch.model.trim() ? patch.model.trim() : base.model,
    speed: patch.speed !== undefined ? clampSpeed(Number(patch.speed)) : base.speed,
    volume: patch.volume !== undefined ? clampVolume(Number(patch.volume)) : base.volume,
    tradeAlerts: asBool(patch.tradeAlerts, base.tradeAlerts),
    entryAlerts: asBool(patch.entryAlerts, base.entryAlerts),
    tpAlerts: asBool(patch.tpAlerts, base.tpAlerts),
    slAlerts: asBool(patch.slAlerts, base.slAlerts),
    noTrade: asBool(patch.noTrade, base.noTrade),
    marketBriefing: asBool(patch.marketBriefing, base.marketBriefing),
    systemAlerts: asBool(patch.systemAlerts, base.systemAlerts),
    telegramVoice: asBool(patch.telegramVoice, base.telegramVoice),
    piperUrl: typeof patch.piperUrl === "string" && patch.piperUrl ? patch.piperUrl : base.piperUrl,
    modelDir: typeof patch.modelDir === "string" && patch.modelDir ? patch.modelDir : base.modelDir,
    audioDir: typeof patch.audioDir === "string" && patch.audioDir ? patch.audioDir : base.audioDir,
    retentionMin: Number.isFinite(Number(patch.retentionMin)) && Number(patch.retentionMin) > 0
      ? Math.round(Number(patch.retentionMin)) : base.retentionMin,
  };
}

function readFileSettings(): Partial<VoiceSettings> {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** env defaults ← file overrides (explicit UI action wins). */
export function loadVoiceSettings(): VoiceSettings {
  return sanitizeSettings(readFileSettings(), defaultVoiceSettings());
}

export function saveVoiceSettings(patch: Partial<VoiceSettings>): VoiceSettings {
  const next = sanitizeSettings({ ...readFileSettings(), ...patch }, defaultVoiceSettings());
  try {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
    fs.writeFileSync(configFilePath(), JSON.stringify(next, null, 2));
  } catch (err: any) {
    console.warn(`[Voice] config save failed: ${err.message}`);
  }
  return next;
}
