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

  const flowWithFns = (a: object, b: object) =>
    ({
      meta: { name: "F", version: "0.1.0" },
      nodes: [
        {
          id: "a",
          type: "initial",
          position: { x: 0, y: 0 },
          data: { task_messages: [{ role: "developer", content: "x" }], functions: [a] },
        },
        {
          id: "b",
          type: "node",
          position: { x: 1, y: 0 },
          data: { task_messages: [{ role: "developer", content: "y" }], functions: [b] },
        },
      ],
      edges: [],
    }) as unknown as FlowJson;

  it("flags same-name functions with conflicting definitions", () => {
    const custom = customGraphChecks(
      flowWithFns(
        { name: "foo", description: "A", next_node_id: "b" },
        { name: "foo", description: "B", next_node_id: "a" }
      )
    );
    expect(custom.some((e) => e.keyword === "uniqueFunctionName")).toBe(true);
  });

  it("allows identical same-name functions across nodes (shared-function pattern)", () => {
    const custom = customGraphChecks(
      flowWithFns({ name: "foo", description: "A" }, { name: "foo", description: "A" })
    );
    expect(custom.some((e) => e.keyword === "uniqueFunctionName")).toBe(false);
  });
});
