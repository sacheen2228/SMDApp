/// <reference types="bun-types" />
// Voice configuration — env base (VOICE_*), UI overrides in data/voice-config.json.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import os from "os";

// fresh module per test (env read at import time)
let cfg: typeof import("@/lib/voice/voiceConfig");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cfg-"));

beforeEach(async () => {
  process.env.VOICE_CONFIG_FILE = path.join(TMP, "voice-config.json");
  for (const k of Object.keys(process.env)) if (k.startsWith("VOICE_")) delete process.env[k];
  process.env.VOICE_CONFIG_FILE = path.join(TMP, "voice-config.json");
  cfg = await import("@/lib/voice/voiceConfig");
});

afterEach(() => {
  try { fs.rmSync(process.env.VOICE_CONFIG_FILE!, { force: true }); } catch {}
});

describe("voiceConfig", () => {
  it("defaults match spec §14", () => {
    const s = cfg.defaultVoiceSettings();
    expect(s.enabled).toBe(true);
    expect(s.provider).toBe("piper");
    expect(s.speed).toBe(0.95);
    expect(s.volume).toBe(1.0);
    expect(s.tradeAlerts).toBe(true);
    expect(s.entryAlerts).toBe(true);
    expect(s.tpAlerts).toBe(true);
    expect(s.slAlerts).toBe(true);
    expect(s.noTrade).toBe(false);
    expect(s.marketBriefing).toBe(true);
    expect(s.systemAlerts).toBe(true);
  });

  it("env overrides defaults", () => {
    process.env.VOICE_ENABLED = "false";
    process.env.VOICE_SPEED = "0.9";
    process.env.VOICE_TP_ALERTS = "false";
    const s = cfg.defaultVoiceSettings();
    expect(s.enabled).toBe(false);
    expect(s.speed).toBe(0.9);
    expect(s.tpAlerts).toBe(false);
  });

  it("clamps speed to 0.80–1.10 and volume to 0–1", () => {
    process.env.VOICE_SPEED = "5";
    process.env.VOICE_VOLUME = "9";
    let s = cfg.defaultVoiceSettings();
    expect(s.speed).toBe(1.1);
    expect(s.volume).toBe(1);
    process.env.VOICE_SPEED = "0.1";
    s = cfg.defaultVoiceSettings();
    expect(s.speed).toBe(0.8);
  });

  it("rejects unknown provider", () => {
    process.env.VOICE_PROVIDER = "elevenlabs";
    expect(cfg.defaultVoiceSettings().provider).toBe("piper");
  });

  it("file overrides env (explicit UI action wins)", () => {
    process.env.VOICE_ENABLED = "true";
    cfg.saveVoiceSettings({ enabled: false, speed: 0.85 });
    const s = cfg.loadVoiceSettings();
    expect(s.enabled).toBe(false);
    expect(s.speed).toBe(0.85);
  });

  it("save clamps and coerces bad values", () => {
    const s = cfg.saveVoiceSettings({ speed: 99 as any, provider: "evil" as any, tpAlerts: "yes" as any });
    expect(s.speed).toBe(1.1);
    expect(s.provider).toBe("piper");
    expect(s.tpAlerts).toBe(true);
  });

  it("load returns defaults when file missing", () => {
    const s = cfg.loadVoiceSettings();
    expect(s.provider).toBe("piper");
    expect(s.enabled).toBe(true);
  });
});
