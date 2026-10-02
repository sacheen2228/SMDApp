// Voice Provider abstraction — free/local TTS only (spec §1).
// Preferred: Kokoro → Piper → other local. No paid APIs, no API keys.

export interface SynthResult {
  audioPath: string;
  format: "wav" | "ogg";
}

export interface TTSSynthesizeOptions {
  model: string;    // voice name (piper voice / espeak voice)
  speed: number;    // 0.80 – 1.10 spoken rate
  volume: number;   // 0 – 1
}

export interface TTSProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  synthesize(text: string, opts: TTSSynthesizeOptions): Promise<SynthResult>;
}

export interface ProviderConfig {
  piperUrl: string;
  modelDir: string;
  audioDir: string;
  retentionMin: number;
}

/** Factory — returns null when no local provider is usable (voice skips, trading unaffected). */
export function createProvider(
  name: "piper" | "kokoro" | "espeak",
  cfg: ProviderConfig
): TTSProvider | null {
  switch (name) {
    case "piper":
      return createPiperProvider(cfg);
    case "espeak":
      return createEspeakProvider(cfg);
    case "kokoro":
      return createKokoroProvider(cfg); // reports unavailable unless installed
    default:
      return null;
  }
}

// Local imports kept at bottom to avoid circular init issues
import { createPiperProvider, createEspeakProvider, createKokoroProvider } from "./localTTSProvider";
