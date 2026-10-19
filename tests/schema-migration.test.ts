import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";

describe("ledger/journal schema — underlying price in its own column", () => {
  const prismaSql = readFileSync("prisma/manual-migrations/20261019_add_candidate_log.sql", "utf8");
  const sidecarSql = readFileSync("trade-audit/migrations/20261019_underlying_spot.sql", "utf8");

  test("prisma migration adds underlyingSpot as NULLABLE and never copies the premium", () => {
    expect(prismaSql).toMatch(/ADD COLUMN "underlyingSpot" REAL/);
    // no UPDATE may copy spot_price/premium into the underlying column
    expect(prismaSql).not.toMatch(/UPDATE\s+"?Trade"?[\s\S]*?SET\s+"?underlyingSpot"?\s*=\s*"?spot/i);
    expect(prismaSql).not.toMatch(/underlyingSpot"?\s*=\s*"?spot_price/i);
  });

  test("trade-audit migration adds underlying_spot and never copies spot_price into it", () => {
    expect(sidecarSql).toMatch(/ADD COLUMN underlying_spot REAL/);
    expect(sidecarSql).not.toMatch(/UPDATE[\s\S]*SET underlying_spot\s*=\s*spot_price/i);
  });

  test("prisma schema declares the column on the journal model and a candidate_log model", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/model CandidateLog/);
    expect(schema).toMatch(/underlyingSpot\s+Float\?/);
    // candidate_log must be able to store a NULL underlying (unknown) and a resolved outcome
    expect(schema).toMatch(/simOutcomeR\s+Float\?/);
    expect(schema).toMatch(/configHash\s+String/);
  });

  test("sidecar keeps the premium column but adds a separate underlying column", () => {
    const sidecarDb = readFileSync("trade-audit/src/db/index.ts", "utf8");
    expect(sidecarDb).toMatch(/underlying_spot\s+REAL/);
    expect(sidecarDb).toMatch(/ensureUnderlyingSpotColumn/);
  });
});
