"use client";

import { useState } from "react";

export default function ConnectionManager() {
  const [testResult, setTestResult] = useState<{ status: string; msg: string } | null>(null);
  const [telegramResult, setTelegramResult] = useState<{ status: string; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [clearing, setClearing] = useState(false);

  const testBreeze = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/breeze-connect/status");
      const json = await res.json();
      if (json.success && json.data?.isConnected) {
        setTestResult({ status: "success", msg: "Breeze API connected ✓" });
      } else {
        setTestResult({ status: "error", msg: json.error || "Breeze API not connected" });
      }
    } catch (e: any) {
      setTestResult({ status: "error", msg: e.message || "Connection test failed" });
    }
    setTesting(false);
  };

  const testTelegram = async () => {
    setTestingTelegram(true);
    setTelegramResult(null);
    try {
      const res = await fetch("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "system",
          message: "✅ Telegram alerts connected successfully! All trade signals will be sent here.",
        }),
      });
      const json = await res.json();
      if (json.success) {
        setTelegramResult({ status: "success", msg: "Test message sent ✓ Check your Telegram" });
      } else {
        setTelegramResult({ status: "error", msg: "Bot API returned error" });
      }
    } catch (e: any) {
      setTelegramResult({ status: "error", msg: e.message || "Telegram test failed" });
    }
    setTestingTelegram(false);
  };

  const clearCache = () => {
    setClearing(true);
    const keys = Object.keys(localStorage).filter(k => k.includes("sdm_") || k.includes("cache") || k.includes("sim_"));
    keys.forEach(k => localStorage.removeItem(k));
    setTimeout(() => setClearing(false), 500);
  };

  const clearAll = () => {
    if (confirm("Clear ALL localStorage data (config, cache, preferences)?")) {
      localStorage.clear();
      setTestResult({ status: "success", msg: "localStorage cleared. Reloading..." });
      setTimeout(() => window.location.reload(), 1000);
    }
  };

  return (
    <div className="space-y-4">
      <div className="text-[11px] font-bold text-muted-foreground">CONNECTION & DATA MANAGEMENT</div>

      {/* Breeze Connection Test */}
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold mb-2">Breeze API Connection</div>
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={testBreeze}
            disabled={testing}
            className="h-7 text-[10px] bg-primary text-primary-foreground px-3 rounded font-bold disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {testResult && (
            <span className={`text-[10px] font-bold ${testResult.status === "success" ? "text-emerald-400" : "text-red-400"}`}>
              {testResult.msg}
            </span>
          )}
        </div>
        <div className="text-[9px] text-muted-foreground">
          Validates your ICICI Breeze session token against the API.
          {!testResult && " Click to check if your credentials are working."}
        </div>
        {testResult?.status === "success" && (
          <div className="mt-2 text-[9px] text-muted-foreground">
            Session valid. Data source will use Breeze API before falling back to NSE.
          </div>
        )}
      </div>

      {/* Telegram Connection */}
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold mb-2">Telegram Bot <span className="text-[9px] font-normal text-muted-foreground">@Sacheen_SD_Bot</span></div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <button
            onClick={testTelegram}
            disabled={testingTelegram}
            className="h-7 text-[10px] bg-sky-500/20 text-sky-400 px-3 rounded font-bold border border-sky-500/30 disabled:opacity-50"
          >
            {testingTelegram ? "Sending..." : "Send Test Message"}
          </button>
          <button
            onClick={async () => {
              try {
                const res = await fetch("/api/telegram/poll");
                const json = await res.json();
                setTelegramResult({ status: json.success ? "success" : "error", msg: json.success ? `Checked — ${json.processed} messages processed` : json.error });
              } catch (e: any) {
                setTelegramResult({ status: "error", msg: e.message });
              }
            }}
            className="h-7 text-[10px] bg-violet-500/20 text-violet-400 px-3 rounded font-bold border border-violet-500/30"
          >
            Check Messages
          </button>
          {telegramResult && (
            <span className={`text-[10px] font-bold ${telegramResult.status === "success" ? "text-emerald-400" : "text-red-400"}`}>
              {telegramResult.msg}
            </span>
          )}
        </div>
        <div className="text-[9px] text-muted-foreground mb-2">
          Sends trade alerts automatically. Also responds to commands you send the bot.
        </div>
        <div className="bg-muted/30 rounded p-2 space-y-0.5 text-[9px] font-mono">
          <div className="text-[10px] font-bold text-sky-400 mb-1">Available Bot Commands</div>
          <div><span className="text-emerald-400">/signal NIFTY</span> — Latest trade signal</div>
          <div><span className="text-emerald-400">/price BANKNIFTY</span> — Current spot price</div>
          <div><span className="text-emerald-400">/status</span> — System health & trade stats</div>
          <div><span className="text-emerald-400">/help</span> — All commands</div>
        </div>
        <div className="mt-2 space-y-0.5 text-[9px] text-muted-foreground">
          <div className="flex items-center gap-1.5"><span className="text-emerald-400">●</span> SDM Engine auto-alerts on strong signals (≥60%)</div>
          <div className="flex items-center gap-1.5"><span className="text-emerald-400">●</span> AI Agent auto-alerts on trade recommendations</div>
          <div className="flex items-center gap-1.5"><span className="text-muted-foreground">○</span> Bot: @Sacheen_SD_Bot · Chat ID: 7862815314</div>
        </div>
      </div>

      {/* Cache Management */}
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold mb-2">Cache & Data Management</div>
        <div className="flex gap-2">
          <button
            onClick={clearCache}
            disabled={clearing}
            className="h-7 text-[10px] bg-orange-500/20 text-orange-400 px-3 rounded font-bold border border-orange-500/30 disabled:opacity-50"
          >
            {clearing ? "Clearing..." : "Clear Sim Cache"}
          </button>
          <button
            onClick={clearAll}
            className="h-7 text-[10px] bg-red-500/20 text-red-400 px-3 rounded font-bold border border-red-500/30"
          >
            Factory Reset
          </button>
        </div>
        <div className="text-[9px] text-muted-foreground mt-2">
          Clear manually fetched API cache. Factory reset removes all preferences.
        </div>
      </div>

      {/* Environment Info */}
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold mb-2">Environment</div>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div>
            <span className="text-muted-foreground">Breeze API Key:</span>{' '}
            {process.env.NEXT_PUBLIC_BREEZE_API_KEY
              ? <span className="text-emerald-400">••••{process.env.NEXT_PUBLIC_BREEZE_API_KEY.slice(-4)}</span>
              : <span className="text-red-400">Not set</span>
            }
          </div>
          <div>
            <span className="text-muted-foreground">Database:</span>{' '}
            <span className="text-emerald-400">SQLite</span>
          </div>
          <div>
            <span className="text-muted-foreground">Node:</span>{' '}
            {typeof process !== "undefined" ? process.version : "—"}
          </div>
          <div>
            <span className="text-muted-foreground">Platform:</span>{' '}
            {typeof navigator !== "undefined" ? navigator.platform : "—"}
          </div>
        </div>
      </div>

      {/* Data Source Info */}
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold mb-2">Data Source Fallback Chain</div>
        <div className="space-y-1 text-[10px]">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>1. ICICI Breeze API (real data)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-500" />
            <span>2. NSE India Scraper (real data)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-orange-500" />
            <span>3. (No simulation fallback — 503 when APIs unavailable)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
