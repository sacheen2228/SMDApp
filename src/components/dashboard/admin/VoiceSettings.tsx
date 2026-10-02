"use client";

// Voice Assistant settings (spec §15) — output layer only, no trading controls.

import { useCallback, useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface VoiceSettings {
  enabled: boolean;
  provider: "piper" | "kokoro" | "espeak";
  model: string;
  speed: number;
  volume: number;
  tradeAlerts: boolean;
  entryAlerts: boolean;
  tpAlerts: boolean;
  slAlerts: boolean;
  noTrade: boolean;
  marketBriefing: boolean;
  systemAlerts: boolean;
  telegramVoice: boolean;
}

export default function VoiceSettings() {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [available, setAvailable] = useState(false);
  const [queue, setQueue] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/voice");
      const j = await res.json();
      setSettings(j.settings);
      setVoices(j.voices || []);
      setAvailable(!!j.providerAvailable);
      setQueue(j.status?.queue || null);
    } catch {
      setTestMsg({ ok: false, msg: "failed to load voice settings" });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const update = async (patch: Partial<VoiceSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      const res = await fetch("/api/voice", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await res.json();
      if (j.settings) setSettings(j.settings);
    } catch {
      setTestMsg({ ok: false, msg: "save failed" });
    }
  };

  const speak = async (action: "test" | "briefing") => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = await res.json();
      if (j.url) {
        setTestMsg({ ok: true, msg: action === "test" ? "voice generated ✓ playing" : "briefing generated ✓ playing" });
        const audio = new Audio(j.url);
        audioRef.current = audio;
        await audio.play().catch(() => {
          setTestMsg({ ok: true, msg: `generated: ${j.url} (autoplay blocked — click again)` });
        });
      } else {
        setTestMsg({ ok: false, msg: j.skipped || j.status || "synthesis failed" });
      }
    } catch (e: any) {
      setTestMsg({ ok: false, msg: e?.message || "voice test failed" });
    }
    setTesting(false);
  };

  if (!settings) return <div className="text-xs text-muted-foreground py-4">Loading voice settings…</div>;

  const toggleRow = (label: string, key: keyof VoiceSettings, hint?: string) => (
    <div className="flex items-center justify-between py-1.5 border-b border-[#1f2430]">
      <div>
        <div className="text-xs font-semibold">{label}</div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </div>
      <Switch checked={!!settings[key]} onCheckedChange={(v) => update({ [key]: v } as any)} />
    </div>
  );

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2">
        <div>
          <div className="font-bold text-cyan-400">🔊 Voice Assistant</div>
          <div className="text-[10px] text-muted-foreground">
            Local TTS · output layer only · never makes trading decisions
          </div>
        </div>
        <Switch checked={settings.enabled} onCheckedChange={(v) => update({ enabled: v })} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className="text-[10px] font-semibold text-muted-foreground">PROVIDER</div>
          <Select value={settings.provider} onValueChange={(v) => update({ provider: v as any })}>
            <SelectTrigger className="h-8 text-xs bg-[#131722]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="piper">Piper (local)</SelectItem>
              <SelectItem value="kokoro">Kokoro (local)</SelectItem>
              <SelectItem value="espeak">espeak-ng (local)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <div className="text-[10px] font-semibold text-muted-foreground">VOICE</div>
          <Select value={settings.model} onValueChange={(v) => update({ model: v })}>
            <SelectTrigger className="h-8 text-xs bg-[#131722]">
              <SelectValue placeholder={voices.length ? "select voice" : "no voices installed"} />
            </SelectTrigger>
            <SelectContent>
              {voices.map((v) => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
              {voices.length === 0 && <SelectItem value="none" disabled>none installed</SelectItem>}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-[10px] font-semibold text-muted-foreground">
          <span>SPEED</span>
          <span className="text-cyan-400">{settings.speed.toFixed(2)}</span>
        </div>
        <Slider
          value={[settings.speed]}
          min={0.8}
          max={1.1}
          step={0.01}
          onValueChange={(v) => setSettings((s) => (s ? { ...s, speed: v[0] } : s))}
          onValueCommit={(v) => update({ speed: v[0] })}
        />
      </div>

      <div>
        {toggleRow("Trade Alerts", "tradeAlerts", "new signal detected — speaks entry/SL/TP")}
        {toggleRow("Entry Alerts", "entryAlerts", "entry confirmation")}
        {toggleRow("TP Alerts", "tpAlerts", "target hit")}
        {toggleRow("SL Alerts", "slAlerts", "stop loss triggered")}
        {toggleRow("No Trade", "noTrade", "engine decided to stand down")}
        {toggleRow("Market Briefing", "marketBriefing", "morning briefing from real data")}
        {toggleRow("System Alerts", "systemAlerts", "startup, market open/close, warnings")}
        {toggleRow("Telegram Voice", "telegramVoice", "deliver audio to Telegram (text alerts unaffected)")}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => speak("test")}
          disabled={testing}
          className="px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 text-[11px] font-bold hover:bg-cyan-500/30 disabled:opacity-50"
        >
          {testing ? "Generating…" : "🔊 Test Voice"}
        </button>
        <button
          onClick={() => speak("briefing")}
          disabled={testing}
          className="px-3 py-1.5 rounded-lg bg-[#131722] text-muted-foreground border border-[#2a2e39] text-[11px] font-bold hover:border-cyan-500/30 disabled:opacity-50"
        >
          📋 Speak Briefing
        </button>
        <div className="text-[10px]">
          {testMsg && <span className={testMsg.ok ? "text-emerald-400" : "text-red-400"}>{testMsg.msg}</span>}
          {!testMsg && !available && <span className="text-amber-400">provider unavailable — check TTS install</span>}
        </div>
      </div>

      {queue && (
        <div className="text-[10px] text-muted-foreground">
          queue: {queue.pending} pending · {queue.completed} done · {queue.failed} failed · {queue.deduped} deduped
        </div>
      )}
    </div>
  );
}
