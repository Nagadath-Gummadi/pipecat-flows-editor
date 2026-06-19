import { describe, expect, it } from "vitest";

import minimal from "@/lib/examples/minimal.json";
import { FlowJson } from "@/lib/schema/flow.schema";
import { customGraphChecks, validateFlowJson } from "@/lib/validation/validator";

describe("validator", () => {
  it("validates minimal example", () => {
    const r = validateFlowJson(minimal);
    expect(r.valid).toBe(true);
    const custom = customGraphChecks(minimal as FlowJson);
    expect(custom.length).toBe(0);
  });

  it("detects duplicate node id", () => {
    const dup = JSON.parse(JSON.stringify(minimal));
    dup.nodes.push({ ...dup.nodes[0] });
    validateFlowJson(dup);
    // schema may still be valid; custom should catch duplicate id
    const custom = customGraphChecks(dup as FlowJson);
    expect(custom.some((e) => String(e.message).includes("Duplicate node id"))).toBe(true);
  });

  it("accepts a positive function timeout_secs but rejects non-positive ones", () => {
    const withTimeout = (secs: number) => {
      const flow = JSON.parse(JSON.stringify(minimal));
      flow.nodes[0].data.functions = [
        { name: "do_work", description: "Do work.", timeout_secs: secs },
      ];
      return flow;
    };
    expect(validateFlowJson(withTimeout(30)).valid).toBe(true);
    expect(validateFlowJson(withTimeout(0)).valid).toBe(false);
    expect(validateFlowJson(withTimeout(-5)).valid).toBe(false);
  });
});
