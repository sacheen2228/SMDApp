// Local TTS providers — Piper (primary), espeak-ng (fallback), Kokoro (stub).
// Piper: local HTTP sidecar (model resident) → one-shot CLI fallback.
// Output: wav synthesized → converted to 48kHz OGG/OPUS for Telegram voice.

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import type { TTSProvider, SynthResult, TTSSynthesizeOptions, ProviderConfig } from "./voiceProvider";

const SIDECAR_TIMEOUT_MS = 20_000;
const CLI_TIMEOUT_MS = 30_000;
const CONVERT_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function run(cmd: string[], timeoutMs: number, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`spawn timeout: ${cmd.join(" ")}`)); }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    try {
      child.stdin.write(input ?? "");
      child.stdin.end();
    } catch {}
  });
}

function newBase(cfg: ProviderConfig): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(cfg.audioDir, `voice-${Date.now()}-${rand}`);
}

/** wav → 48kHz OGG/OPUS (Telegram voice format). Returns ogg path or null. */
async function convertToOgg(wavPath: string, volume: number): Promise<string | null> {
  const oggPath = wavPath.replace(/\.wav$/, ".ogg");
  const script = path.join(process.cwd(), "scripts", "voice-convert.py");
  try {
    if (!fs.existsSync(script)) return null;
    const res = await run(["python3", script, wavPath, oggPath, String(volume)], CONVERT_TIMEOUT_MS);
    if (res.code === 0 && fs.existsSync(oggPath)) {
      try { fs.unlinkSync(wavPath); } catch {}
      return oggPath;
    }
    return null;
  } catch {
    return null;
  }
}

/** Spec §18 — temporary storage, automatic cleanup of old files. */
export function sweepAudioDir(cfg: ProviderConfig): void {
  try {
    if (!fs.existsSync(cfg.audioDir)) return;
    const cutoff = Date.now() - cfg.retentionMin * 60_000;
    for (const f of fs.readdirSync(cfg.audioDir)) {
      if (!/^voice-.*\.(wav|ogg)$/.test(f)) continue;
      const full = path.join(cfg.audioDir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch {}
    }
  } catch {}
}

// ─── Piper ────────────────────────────────────────────────────────

export function createPiperProvider(cfg: ProviderConfig): TTSProvider {
  let sidecarAlive: { at: number; ok: boolean } | null = null;
  let cliOk: { at: number; ok: boolean } | null = null;

  const checkSidecar = async (): Promise<boolean> => {
    if (sidecarAlive && Date.now() - sidecarAlive.at < 60_000) return sidecarAlive.ok;
    let ok = false;
    try {
      // any HTTP response means the sidecar is up
      await withTimeout(fetch(cfg.piperUrl, { method: "GET" }), 2_000, "sidecar probe");
      ok = true;
    } catch {
      ok = false;
    }
    sidecarAlive = { at: Date.now(), ok };
    return ok;
  };

  const checkCli = async (): Promise<boolean> => {
    if (cliOk && Date.now() - cliOk.at < 300_000) return cliOk.ok;
    let ok = false;
    try {
      const modelPath = path.join(cfg.modelDir, "en_US-ryan-medium.onnx");
      const res = await run(["python3", "-c", "import piper"], 5_000);
      ok = res.code === 0 && fs.existsSync(modelPath);
    } catch {
      ok = false;
    }
    cliOk = { at: Date.now(), ok };
    return ok;
  };

  return {
    name: "piper",

    async isAvailable(): Promise<boolean> {
      return (await checkSidecar()) || (await checkCli());
    },

    async synthesize(text: string, opts: TTSSynthesizeOptions): Promise<SynthResult> {
      const base = newBase(cfg);
      const wavPath = `${base}.wav`;
      const lengthScale = Math.min(1.25, Math.max(0.9, 1 / (opts.speed || 1)));

      let synthesized = false;
      // 1) persistent sidecar (fast, model resident)
      if (await checkSidecar()) {
        try {
          const res = await withTimeout(
            fetch(`${cfg.piperUrl}/synthesize`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text, length_scale: lengthScale }),
            }),
            SIDECAR_TIMEOUT_MS,
            "sidecar synth"
          );
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 0) {
              fs.writeFileSync(wavPath, buf);
              synthesized = true;
            }
          }
        } catch {
          synthesized = false; // fall through to CLI
        }
      }
      // 2) one-shot CLI (model reload each call — slower but self-contained)
      if (!synthesized) {
        if (!(await checkCli())) throw new Error("piper unavailable (no sidecar, no CLI)");
        let modelPath = path.join(cfg.modelDir, opts.model || "en_US-ryan-medium");
        if (!modelPath.endsWith(".onnx")) modelPath += ".onnx";
        if (!fs.existsSync(modelPath)) throw new Error(`voice model missing: ${modelPath}`);
        // text via stdin — verified working piper CLI interface
        const res = await run(["python3", "-m", "piper", "-m", modelPath, "-f", wavPath], CLI_TIMEOUT_MS, text + "\n");
        if (res.code !== 0 || !fs.existsSync(wavPath)) throw new Error(`piper CLI failed: ${res.stderr.slice(0, 200)}`);
      }
      if (!fs.existsSync(wavPath)) throw new Error("piper produced no audio");

      // 3) convert to Telegram-friendly OGG/OPUS (best effort)
      const ogg = await convertToOgg(wavPath, opts.volume);
      // 4) retention cleanup (async, never blocks caller path critically)
      setImmediate(() => sweepAudioDir(cfg));
      return ogg ? { audioPath: ogg, format: "ogg" } : { audioPath: wavPath, format: "wav" };
    },
  };
}

// ─── espeak-ng (last-resort local fallback) ───────────────────────

export function createEspeakProvider(cfg: ProviderConfig): TTSProvider {
  return {
    name: "espeak",
    async isAvailable(): Promise<boolean> {
      try {
        const res = await run(["espeak-ng", "--version"], 3_000);
        return res.code === 0;
      } catch {
        return false;
      }
    },
    async synthesize(text: string, opts: TTSSynthesizeOptions): Promise<SynthResult> {
      const base = newBase(cfg);
      const wavPath = `${base}.wav`;
      const speedWpm = Math.round(150 * (opts.speed || 1));
      const res = await run(["espeak-ng", "-v", "en-us", "-s", String(speedWpm), "-a", String(Math.round(100 * opts.volume)), "-w", wavPath, text], 10_000);
      if (res.code !== 0 || !fs.existsSync(wavPath)) throw new Error("espeak-ng failed");
      const ogg = await convertToOgg(wavPath, 1);
      setImmediate(() => sweepAudioDir(cfg));
      return ogg ? { audioPath: ogg, format: "ogg" } : { audioPath: wavPath, format: "wav" };
    },
  };
}

// ─── Kokoro (preferred by spec, but not installed — reports unavailable) ──

export function createKokoroProvider(cfg: ProviderConfig): TTSProvider {
  return {
    name: "kokoro",
    async isAvailable(): Promise<boolean> {
      try {
        const res = await run(["python3", "-c", "import kokoro"], 3_000);
        return res.code === 0;
      } catch {
        return false;
      }
    },
    async synthesize(): Promise<SynthResult> {
      throw new Error("kokoro not installed — run: pip3 install kokoro (requires ~1GB deps)");
    },
  };
}
