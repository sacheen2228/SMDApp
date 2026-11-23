import { describe, it, expect } from "bun:test";
import {
  classifyFlowBuildup,
  classifyFlowDivergence,
} from "@/engines/orderflow/orderflow-engine";

describe("classifyFlowBuildup", () => {
  it("maps price direction and OI change to the build-up states", () => {
    expect(classifyFlowBuildup(1, 100)).toBe("LONG_BUILDUP");
    expect(classifyFlowBuildup(-1, 100)).toBe("SHORT_BUILDUP");
    expect(classifyFlowBuildup(1, -100)).toBe("SHORT_COVERING");
    expect(classifyFlowBuildup(-1, -100)).toBe("LONG_UNWINDING");
  });

  it("returns null when either input is unknown", () => {
    expect(classifyFlowBuildup(null, 100)).toBeNull();
    expect(classifyFlowBuildup(1, null)).toBeNull();
    expect(classifyFlowBuildup(null, null)).toBeNull();
  });

  it("returns NEUTRAL when price did not move", () => {
    expect(classifyFlowBuildup(0, 100)).toBe("NEUTRAL");
  });
});

describe("classifyFlowDivergence", () => {
  it("maps price direction and OI change to the divergence states", () => {
    expect(classifyFlowDivergence(1, 100)).toBe("PRICE_UP_OI_UP");
    expect(classifyFlowDivergence(-1, 100)).toBe("PRICE_DOWN_OI_UP");
    expect(classifyFlowDivergence(1, -100)).toBe("PRICE_UP_OI_DOWN");
    expect(classifyFlowDivergence(-1, -100)).toBe("PRICE_DOWN_OI_DOWN");
  });

  it("returns null when either input is unknown", () => {
    expect(classifyFlowDivergence(null, 100)).toBeNull();
    expect(classifyFlowDivergence(1, null)).toBeNull();
  });
});
