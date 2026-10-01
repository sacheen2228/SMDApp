import { describe, test, expect, afterEach } from "bun:test";
import { providerHealth } from "@/lib/provider-health";

// Circuit-breaker semantics required for the manual token-apply flow:
// when a provider succeeds (e.g. fresh Breeze session at login), the
// circuit must close IMMEDIATELY — not linger OPEN until cooldown.

describe("provider-health circuit on success", () => {
  afterEach(() => {
    providerHealth.resetProvider("yahoo");
    providerHealth.resetProvider("breeze");
  });

  test("recordSuccess closes an OPEN circuit and clears the cooldown", () => {
    for (let i = 0; i < 8; i++) {
      providerHealth.recordFailure("yahoo", "NETWORK", "simulated outage");
    }
    expect(providerHealth.shouldSkip("yahoo")).toBe(true); // circuit OPEN

    providerHealth.recordSuccess("yahoo", 120);

    expect(providerHealth.shouldSkip("yahoo")).toBe(false); // closed immediately
    expect(providerHealth.shouldSkip("yahoo")).toBe(false); // no cooldown window
  });

  test("success after OPEN is idempotent (double success harmless)", () => {
    for (let i = 0; i < 8; i++) {
      providerHealth.recordFailure("yahoo", "NETWORK", "simulated outage");
    }
    providerHealth.recordSuccess("yahoo", 90);
    providerHealth.recordSuccess("yahoo", 95);
    expect(providerHealth.shouldSkip("yahoo")).toBe(false);
  });
});
