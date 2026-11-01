/// <reference types="bun-types" />
// Skill job registry (src/lib/orchestrator/skill-jobs.ts) — the command each
// scheduled job runs.  The live-breadth job used to invoke a SHELL script
// (scripts/live_fetch.sh) through `python3`, which died every 5 minutes with
// `SyntaxError: invalid decimal literal` at the `ls -1t ... | tail -n +N` line.
// The interpreter in the registry must match the file extension.

import { describe, it, expect } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import { SKILL_JOBS, SKILL_ROOT } from "@/lib/orchestrator/skill-jobs";

const INTERPRETERS: Record<string, string[]> = {
  ".py": ["python3"],
  ".sh": ["bash"],
};

describe("SKILL_JOBS — the interpreter matches the script it runs", () => {
  it("registers the documented jobs", () => {
    const names = SKILL_JOBS.map((j) => j.name).sort();
    expect(names).toEqual(
      ["daily-bias", "eod-fetch", "eod-pcr", "gex-engine", "holidays", "live-breadth"].sort()
    );
  });

  for (const job of SKILL_JOBS) {
    it(`${job.name}: runs its script with the right interpreter`, () => {
      const [interpreter, script] = job.command;
      expect(interpreter === "python3" || interpreter === "bash").toBe(true);
      const ext = path.extname(script);
      expect(INTERPRETERS[ext]).toContain(interpreter);
      // the script must actually exist — a registry entry pointing at a
      // missing file fails every single run
      expect(fs.existsSync(script)).toBe(true);
    });
  }

  it("eod-pcr reads the snapshot the gex-engine job publishes", () => {
    const job = SKILL_JOBS.find((j) => j.name === "eod-pcr")!;
    expect(job.command).toContain(path.join(SKILL_ROOT, "data/live/gex_snapshot.json"));
    // the producer of that file is run_gex.py (the gex-engine job)
    const gex = SKILL_JOBS.find((j) => j.name === "gex-engine")!;
    expect(gex.command.join(" ")).toContain("run_gex.py");
    const runGex = fs.readFileSync(path.join(SKILL_ROOT, "scripts/run_gex.py"), "utf8");
    expect(runGex).toContain("gex_snapshot.json");
  });
});
