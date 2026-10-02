/// <reference types="bun-types" />
// read_playbook tool — links skills/option-buying-playbook reference docs into
// the SDM chat bot. Bug: agent-brain.ts told the model "full skill lives at
// skills/option-buying-playbook/ — use it for deep scoring requests" but no
// file-read tool existed, so the 8 reference docs (incl. new math-and-formulas.md
// and vix-and-strike-selection.md) were dead links.

import { describe, it, expect } from "bun:test";
import { executeTool, selectToolsForQuery, AGENT_TOOLS } from "@/lib/agent-brain";

const ctx = { symbol: "NIFTY", spotPrice: 22400, analysis: {}, summary: { indiaVIX: 14.4 } };

describe("read_playbook tool", () => {
  it("lists available playbook files when no file given", async () => {
    const out = await executeTool("read_playbook", {}, ctx);
    expect(out).toContain("SKILL.md");
    expect(out).toContain("references/math-and-formulas.md");
    expect(out).toContain("references/vix-and-strike-selection.md");
  });

  it("reads SKILL.md", async () => {
    const out = await executeTool("read_playbook", { file: "SKILL.md" }, ctx);
    expect(out).toContain("Option Buying Playbook");
    expect(out).not.toContain("No such file");
  });

  it("reads a reference doc (math & formulas)", async () => {
    const out = await executeTool("read_playbook", { file: "references/math-and-formulas.md" }, ctx);
    expect(out.length).toBeGreaterThan(500);
    expect(out).not.toContain("No such file");
    expect(out).not.toMatch(/BREEZE_SECRET|DATABASE_URL/);
  });

  it("accepts a path prefixed with the skill directory", async () => {
    const out = await executeTool("read_playbook", { file: "skills/option-buying-playbook/SKILL.md" }, ctx);
    expect(out).toContain("Option Buying Playbook");
  });

  it("blocks path traversal outside the skill", async () => {
    for (const evil of ["../../.env", "../other-skill/SKILL.md", "/etc/passwd", "scripts/../../../.env"]) {
      const out = await executeTool("read_playbook", { file: evil }, ctx);
      expect(out, `must block: ${evil}`).not.toContain("BREEZE_SECRET");
      expect(out).not.toContain("root:x:");
      expect(out.toLowerCase()).toMatch(/available|not allowed|blocked|no such/);
    }
  });

  it("unknown file → helpful list instead of an error", async () => {
    const out = await executeTool("read_playbook", { file: "references/does-not-exist.md" }, ctx);
    expect(out).toContain("No such file");
    expect(out).toContain("SKILL.md");
  });

  it("non-markdown file is refused", async () => {
    const out = await executeTool("read_playbook", { file: "scripts/strike_selector.py" }, ctx);
    expect(out).toMatch(/\.md|No such file|not allowed/);
  });
});

describe("read_playbook registration", () => {
  it("is registered in AGENT_TOOLS with a callable schema", () => {
    const def: any = AGENT_TOOLS.find((t: any) => t.function?.name === "read_playbook");
    expect(def).toBeTruthy();
    expect(typeof def.function.description).toBe("string");
    expect(def.function.parameters.type).toBe("object");
    expect(def.function.parameters.properties.file).toBeTruthy();
  });

  it("router selects it for checklist / formula / deep scoring questions", () => {
    const picks = (q: string) => selectToolsForQuery(q).map((t: any) => t.function.name);
    expect(picks("what is the scoring checklist for a trade setup?")).toContain("read_playbook");
    expect(picks("explain the black-scholes formula and expected move math")).toContain("read_playbook");
    expect(picks("open the option buying playbook reference doc")).toContain("read_playbook");
  });
});
