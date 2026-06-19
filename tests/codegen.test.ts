import { describe, expect, it } from "vitest";

import { generatePythonCode } from "@/lib/codegen/pythonGenerator";
import foodOrdering from "@/lib/examples/food_ordering.json";
import type { FlowJson } from "@/lib/schema/flow.schema";

const food = foodOrdering as unknown as FlowJson;

describe("python code generation (pipecat-flows 1.3.0 direct functions)", () => {
  const code = generatePythonCode(food);

  it("imports only the modern flows surface", () => {
    expect(code).toContain("from pipecat_flows import (");
    expect(code).toContain("FlowManager");
    expect(code).toContain("NodeConfig");
    // Legacy/removed APIs must not be generated.
    expect(code).not.toContain("FlowsFunctionSchema");
    expect(code).not.toContain("FlowArgs");
    expect(code).not.toContain("FlowResult");
  });

  it("emits direct functions with flow_manager first and typed params", () => {
    expect(code).toContain(
      "async def select_pizza_order(flow_manager: FlowManager, size: str, type: str) -> tuple[SelectPizzaOrderResult, NodeConfig]:"
    );
    // No handler indirection / arg extraction.
    expect(code).not.toContain("handle_select_pizza_order");
    expect(code).not.toContain('args.get("size"');
  });

  it("references functions directly in the node's functions list", () => {
    expect(code).toContain("functions=[choose_pizza, choose_sushi]");
    expect(code).toContain("functions=[select_pizza_order]");
  });

  it("routes to the next node via the returned NodeConfig", () => {
    expect(code).toContain(
      "return SelectPizzaOrderResult(size=size, type=type), create_confirm_node()"
    );
    // Transition-only function returns None as the result.
    expect(code).toContain(
      "async def choose_pizza(flow_manager: FlowManager) -> tuple[None, NodeConfig]:"
    );
    expect(code).toContain("return None, create_pizza_task_node()");
  });

  it("declares result types as plain TypedDicts", () => {
    expect(code).toContain("from typing import TypedDict");
    expect(code).toContain("class SelectPizzaOrderResult(TypedDict):");
    expect(code).toContain("    size: str");
  });

  it("folds JSON-Schema enum constraints into the docstring Args section", () => {
    expect(code).toContain("Args:");
    expect(code).toContain('Allowed values: "small", "medium", "large".');
  });

  it("collapses role_messages into a single role_message string", () => {
    expect(code).toContain("role_message=");
    expect(code).not.toContain("role_messages=");
  });

  it("uses the modern worker-based FlowManager setup", () => {
    expect(code).toContain("worker=worker,");
    expect(code).toContain("await flow_manager.initialize(create_initial_node())");
    expect(code).not.toContain("task=task");
  });
});

describe("decision routing", () => {
  const flowWithDecision: FlowJson = {
    meta: { name: "Decision Flow", version: "0.1.0" },
    nodes: [
      {
        id: "start",
        type: "initial",
        position: { x: 0, y: 0 },
        data: {
          label: "Start",
          task_messages: [{ role: "developer", content: "Ask for a number." }],
          functions: [
            {
              name: "check_value",
              description: "Check the provided value.",
              properties: { value: { type: "integer", description: "The value." } },
              required: ["value"],
              decision: {
                action: "result = value",
                conditions: [{ operator: ">", value: "10", next_node_id: "big" }],
                default_next_node_id: "small",
              },
            },
          ],
        },
      },
      {
        id: "big",
        type: "node",
        position: { x: 1, y: 0 },
        data: { label: "Big", task_messages: [{ role: "developer", content: "Big." }] },
      },
      {
        id: "small",
        type: "node",
        position: { x: 2, y: 0 },
        data: { label: "Small", task_messages: [{ role: "developer", content: "Small." }] },
      },
    ],
    edges: [],
  };

  it("imports Any and emits if/elif/else branching", () => {
    const code = generatePythonCode(flowWithDecision);
    expect(code).toContain("from typing import Any");
    expect(code).toContain(
      "async def check_value(flow_manager: FlowManager, value: int) -> tuple[Any, NodeConfig]:"
    );
    expect(code).toContain("result = value");
    expect(code).toContain("if result > 10:");
    expect(code).toContain("return result, create_big_node()");
    expect(code).toContain("return result, create_small_node()");
  });
});

describe("global functions", () => {
  const flowWithGlobal: FlowJson = {
    meta: { name: "Global Flow", version: "0.1.0" },
    global_functions: [
      {
        name: "get_estimate",
        description: "Provide an estimate.",
      },
    ],
    nodes: [
      {
        id: "start",
        type: "initial",
        position: { x: 0, y: 0 },
        data: { label: "Start", task_messages: [{ role: "developer", content: "Hi." }] },
      },
    ],
    edges: [],
  };

  it("emits global functions and references them in the setup", () => {
    const code = generatePythonCode(flowWithGlobal);
    expect(code).toContain("# Global functions (available at every node)");
    expect(code).toContain(
      "async def get_estimate(flow_manager: FlowManager) -> tuple[None, None]:"
    );
    expect(code).toContain("global_functions=[get_estimate],");
  });
});

describe("@flows_tool_options call options", () => {
  function flowWith(opts: { cancel_on_interruption?: boolean; timeout_secs?: number }): FlowJson {
    return {
      meta: { name: "Options Flow", version: "0.1.0" },
      nodes: [
        {
          id: "start",
          type: "initial",
          position: { x: 0, y: 0 },
          data: {
            label: "Start",
            task_messages: [{ role: "developer", content: "Hi." }],
            functions: [{ name: "do_work", description: "Do some work.", ...opts }],
          },
        },
      ],
      edges: [],
    };
  }

  it("emits no decorator and no import when options are default", () => {
    const code = generatePythonCode(flowWith({}));
    expect(code).not.toContain("flows_tool_options");
  });

  it("emits the decorator and import when cancel_on_interruption is set", () => {
    const code = generatePythonCode(flowWith({ cancel_on_interruption: true }));
    expect(code).toContain("    flows_tool_options,");
    expect(code).toContain("@flows_tool_options(cancel_on_interruption=True)\nasync def do_work(");
  });

  it("emits timeout_secs and combines both options", () => {
    const code = generatePythonCode(flowWith({ cancel_on_interruption: true, timeout_secs: 30 }));
    expect(code).toContain(
      "@flows_tool_options(cancel_on_interruption=True, timeout_secs=30)\nasync def do_work("
    );
  });

  it("emits only timeout_secs when cancel_on_interruption is unset", () => {
    const code = generatePythonCode(flowWith({ timeout_secs: 5 }));
    expect(code).toContain("@flows_tool_options(timeout_secs=5)\nasync def do_work(");
    expect(code).not.toContain("cancel_on_interruption");
  });
});

describe("escaping and de-duplication", () => {
  it("escapes triple quotes in a multi-line description so the docstring stays valid", () => {
    const flow: FlowJson = {
      meta: { name: "Quote Flow", version: "0.1.0" },
      nodes: [
        {
          id: "start",
          type: "initial",
          position: { x: 0, y: 0 },
          data: {
            label: "Start",
            task_messages: [{ role: "developer", content: "Hi." }],
            functions: [
              {
                name: "do_work",
                description: 'Wrap text in """triple quotes""".\nSecond line.',
                properties: { value: { type: "string", description: 'Use """ here.' } },
                required: ["value"],
              },
            ],
          },
        },
      ],
      edges: [],
    };
    const code = generatePythonCode(flow);
    // The raw triple-quote sequence must be escaped, never left to close the docstring.
    expect(code).not.toMatch(/[^\\]"""triple/);
    expect(code).toContain('\\"\\"\\"triple');
    expect(code).toContain('Use \\"\\"\\" here.');
  });

  it("does not redefine a global function that shares a node function's name", () => {
    const flow: FlowJson = {
      meta: { name: "Shared Name Flow", version: "0.1.0" },
      global_functions: [{ name: "shared", description: "Global version." }],
      nodes: [
        {
          id: "start",
          type: "initial",
          position: { x: 0, y: 0 },
          data: {
            label: "Start",
            task_messages: [{ role: "developer", content: "Hi." }],
            functions: [{ name: "shared", description: "Node version." }],
          },
        },
      ],
      edges: [],
    };
    const code = generatePythonCode(flow);
    const defs = code.match(/^async def shared\(/gm) ?? [];
    expect(defs.length).toBe(1);
  });
});
