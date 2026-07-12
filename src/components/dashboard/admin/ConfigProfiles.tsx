"use client";

import { useState, useEffect } from "react";
import {
  loadStrategyConfig, saveStrategyConfig, resetStrategyConfig,
  exportStrategyConfig, importStrategyConfig,
} from "@/lib/strategy-config";

interface ConfigProfile {
  name: string;
  timestamp: string;
  json: string;
}

const PROFILES_KEY = "sdm_config_profiles";

function loadProfiles(): ConfigProfile[] {
  try {
    const stored = localStorage.getItem(PROFILES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function saveProfiles(profiles: ConfigProfile[]) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

export default function ConfigProfiles() {
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [compareJson, setCompareJson] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => { setProfiles(loadProfiles()); }, []);

  const refreshProfiles = () => setProfiles(loadProfiles());

  const saveProfile = () => {
    const name = profileName.trim() || `Profile ${profiles.length + 1}`;
    const current = loadStrategyConfig();
    const profile: ConfigProfile = {
      name,
      timestamp: new Date().toISOString(),
      json: exportStrategyConfig(current),
    };
    const updated = [...profiles.filter(p => p.name !== name), profile];
    saveProfiles(updated);
    setProfiles(updated);
    setProfileName("");
  };

  const loadProfile = (profile: ConfigProfile) => {
    try {
      const config = importStrategyConfig(profile.json);
      saveStrategyConfig(config);
      alert(`Loaded "${profile.name}" — page will reload to apply.`);
      window.location.reload();
    } catch {
      alert("Failed to load profile (invalid JSON).");
    }
  };

  const deleteProfile = (name: string) => {
    if (!confirm(`Delete "${name}"?`)) return;
    const updated = profiles.filter(p => p.name !== name);
    saveProfiles(updated);
    setProfiles(updated);
  };

  const compareProfile = (profile: ConfigProfile) => {
    const current = loadStrategyConfig();
    const currJson = JSON.stringify(current, null, 2);
    const profJson = profile.json;
    if (currJson === profJson) {
      setCompareJson("Configs are identical ✓");
    } else {
      setCompareJson(`Current vs "${profile.name}":\n\nDifferences detected. Current config differs from saved profile.`);
    }
    setShowDiff(true);
  };

  const factoryReset = () => {
    if (!confirm("Reset ALL strategy parameters to factory defaults? This cannot be undone.")) return;
    const config = resetStrategyConfig();
    saveStrategyConfig(config);
    alert("Reset to defaults. Page will reload.");
    window.location.reload();
  };

  return (
    <div className="space-y-4">
      <div className="text-[11px] font-bold text-muted-foreground">CONFIG PROFILES</div>

      {/* Save profile */}
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold mb-2">Save Current Config</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={profileName}
            onChange={e => setProfileName(e.target.value)}
            placeholder="Profile name..."
            className="flex-1 h-7 text-[10px] bg-muted border border-border/50 rounded px-2"
            onKeyDown={e => e.key === "Enter" && saveProfile()}
          />
          <button
            onClick={saveProfile}
            className="h-7 text-[10px] bg-primary text-primary-foreground px-3 rounded font-bold"
          >
            Save
          </button>
        </div>
      </div>

      {/* Profiles list */}
      <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
        <div className="text-[11px] font-bold mb-2">
          Saved Profiles ({profiles.length})
          <button onClick={refreshProfiles} className="ml-2 text-[9px] text-primary hover:underline">Refresh</button>
        </div>
        {profiles.length === 0 ? (
          <div className="text-[10px] text-muted-foreground py-2">
            No saved profiles yet. Configure your strategy and save it above.
          </div>
        ) : (
          <div className="space-y-1">
            {profiles.map(p => {
              const parsed = JSON.parse(p.json);
              return (
              <div key={p.name} className="flex items-center justify-between p-2 bg-muted/30 rounded hover:bg-muted/50">
                <div>
                  <div className="text-[11px] font-bold">{p.name}</div>
                  <div className="text-[9px] text-muted-foreground">
                    Saved: {new Date(p.timestamp).toLocaleString("en-IN")} · {parsed.version ? `v${parsed.version}` : ""}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => loadProfile(p)} className="h-6 text-[9px] bg-primary text-primary-foreground px-2 rounded font-bold">Load</button>
                  <button onClick={() => compareProfile(p)} className="h-6 text-[9px] bg-blue-500/20 text-blue-400 px-2 rounded">Diff</button>
                  <button onClick={() => deleteProfile(p.name)} className="h-6 text-[9px] bg-red-500/20 text-red-400 px-2 rounded">Del</button>
                </div>
              </div>
            );
          })}
          </div>
        )}
      </div>

      {/* Diff view */}
      {showDiff && compareJson && (
        <div className="bg-[#1a1d28] border border-[#2a2e39] rounded-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-bold">Comparison</div>
            <button onClick={() => setShowDiff(false)} className="text-[10px] text-muted-foreground hover:text-foreground">✕</button>
          </div>
          <pre className="text-[9px] text-muted-foreground font-mono whitespace-pre-wrap">{compareJson}</pre>
        </div>
      )}

      {/* Factory Reset */}
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
        <div className="text-[11px] font-bold text-red-400 mb-1">Danger Zone</div>
        <div className="text-[10px] text-muted-foreground mb-2">
          Restore all strategy parameters to factory defaults. Saved profiles are not affected.
        </div>
        <button onClick={factoryReset} className="h-7 text-[10px] bg-red-500/20 text-red-400 px-3 rounded font-bold border border-red-500/30">
          Factory Reset Strategy
        </button>
      </div>
    </div>
  );
}
