import type {
  FlowFunctionJson,
  FlowJson,
  FlowNodeJson,
  GlobalFunctionJson,
  MessageJson,
} from "@/lib/schema/flow.schema";

const INDENT = "    ";

type AnyFunction = FlowFunctionJson | GlobalFunctionJson;

function escapePythonString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Escape user text for safe embedding inside a """...""" string, preserving
// newlines. Backslashes are escaped first (so sequences like \u can't form an
// invalid Python escape and a trailing \ can't escape the closing quote); then
// any """ run is escaped so it can't close the string early. Interior single
// quotes are left untouched for readability.
function escapeTripleQuotes(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

// When escaped content sits immediately before a closing """, a trailing " (or
// "") would merge into """" and break the literal. Escape a trailing quote so
// the delimiter stays unambiguous. (Not needed when a newline separates the
// content from the closing delimiter.)
function guardTrailingQuote(str: string): string {
  return str.endsWith('"') ? `${str.slice(0, -1)}\\"` : str;
}

// Render a string as a Python literal: triple-quoted when it spans multiple
// lines, otherwise a regular double-quoted string.
function pythonStringLiteral(content: string): string {
  if (content.includes("\n")) {
    return `"""${guardTrailingQuote(escapeTripleQuotes(content))}"""`;
  }
  return JSON.stringify(content);
}

// Map a JSON-Schema property type to a Python type hint.
function pyType(type: string | undefined): string {
  switch (type) {
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "array":
      return "list";
    case "object":
      return "dict";
    default:
      return "str";
  }
}

function generateTypeName(funcName: string): string {
  // Convert snake_case to PascalCase
  return (
    funcName
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join("") + "Result"
  );
}

function hasProperties(func: AnyFunction): boolean {
  return Object.keys(func.properties || {}).length > 0;
}

// Order a function's properties with required ones first. This keeps the
// generated signature valid (parameters with defaults must follow those
// without) and ensures the signature, docstring, result type, and result value
// all agree on ordering.
function orderedKeys(func: AnyFunction): { key: string; required: boolean }[] {
  const keys = Object.keys(func.properties || {});
  const required = new Set(func.required || []);
  return [...keys.filter((k) => required.has(k)), ...keys.filter((k) => !required.has(k))].map(
    (key) => ({ key, required: required.has(key) })
  );
}

// Result types are emitted as plain TypedDicts. `FlowResult` is deprecated in
// pipecat-flows 1.x: handlers may return any JSON-serializable value. Optional
// (non-required) inputs are nullable, matching their `| None = None` defaults.
function generateTypeDefinition(func: AnyFunction): string {
  const typeName = generateTypeName(func.name);
  const props = func.properties || {};

  const fields = orderedKeys(func).map(({ key, required }) => {
    const t = pyType(props[key].type);
    return `    ${key}: ${required ? t : `${t} | None`}`;
  });

  return `class ${typeName}(TypedDict):
    """Result type for the ${func.name} function."""
${fields.join("\n")}`;
}

function formatMessage(msg: MessageJson): string {
  const contentStr = pythonStringLiteral(msg.content);
  return `            {\n                "role": "${msg.role}",\n                "content": ${contentStr},\n            }`;
}

// Build the docstring `Args:` description for a single parameter, folding any
// JSON-Schema constraints (enum/min/max/pattern) into prose. Direct functions
// derive their schema from type hints + docstring, so constraints have no other
// place to live.
function buildArgDescription(prop: {
  description?: string;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
}): string {
  const parts: string[] = [];
  if (prop.description) {
    let d = prop.description.trim();
    if (d && !/[.!?]$/.test(d)) d += ".";
    parts.push(d);
  }
  if (prop.enum && prop.enum.length > 0) {
    const values = prop.enum.map((v) => (typeof v === "string" ? `"${v}"` : v)).join(", ");
    parts.push(`Allowed values: ${values}.`);
  }
  if (prop.minimum !== undefined) parts.push(`Minimum: ${prop.minimum}.`);
  if (prop.maximum !== undefined) parts.push(`Maximum: ${prop.maximum}.`);
  if (prop.pattern) parts.push(`Must match the pattern: ${prop.pattern}.`);
  return parts.join(" ").trim() || "...";
}

// Build the full docstring block (already indented one level into the function
// body). The summary becomes the tool description; the `Args:` section
// describes each parameter for the LLM.
function buildDocstring(func: AnyFunction): string {
  const raw = (func.description || "").trim() || `Handle the ${func.name} function.`;
  const description = escapeTripleQuotes(raw);
  const props = func.properties || {};
  const keys = Object.keys(props);

  if (keys.length === 0) {
    if (description.includes("\n")) {
      const body = description
        .split("\n")
        .map((line) => `${INDENT}${line}`)
        .join("\n");
      return `${INDENT}"""\n${body}\n${INDENT}"""`;
    }
    return `${INDENT}"""${description}"""`;
  }

  const descBody = description
    .split("\n")
    .map((line) => `${INDENT}${line}`)
    .join("\n");
  const argLines = orderedKeys(func)
    .map(
      ({ key }) =>
        `${INDENT}${INDENT}${key} (${pyType(props[key].type)}): ${escapeTripleQuotes(
          buildArgDescription(props[key])
        )}`
    )
    .join("\n");

  return `${INDENT}"""\n${descBody}\n\n${INDENT}Args:\n${argLines}\n${INDENT}"""`;
}

// Build the typed parameter list that follows `flow_manager` in a direct
// function signature, e.g. ", size: int, party_size: int". Non-required
// properties become optional parameters (`name: type | None = None`) so the
// derived tool schema marks them optional too.
function buildParams(func: AnyFunction): string {
  const props = func.properties || {};
  return orderedKeys(func)
    .map(({ key, required }) => {
      const t = pyType(props[key].type);
      return required ? `, ${key}: ${t}` : `, ${key}: ${t} | None = None`;
    })
    .join("");
}

// True when a function overrides any @flows_tool_options default.
function usesToolOptions(func: AnyFunction): boolean {
  return Boolean(func.cancel_on_interruption) || func.timeout_secs != null;
}

// Build the optional `@flows_tool_options(...)` decorator line (with a trailing
// newline), or an empty string when the call options are left at their defaults.
function buildToolOptionsDecorator(func: AnyFunction): string {
  if (!usesToolOptions(func)) return "";
  const opts: string[] = [];
  if (func.cancel_on_interruption) opts.push("cancel_on_interruption=True");
  if (func.timeout_secs != null) opts.push(`timeout_secs=${func.timeout_secs}`);
  return `@flows_tool_options(${opts.join(", ")})\n`;
}

// Generate a single direct function. Works for both node functions (which may
// route to a next node or branch via a decision) and global functions (no
// routing). The schema is extracted automatically by pipecat-flows from the
// signature and docstring below.
function generateDirectFunction(func: AnyFunction): string {
  const funcName = func.name;
  const hasType = hasProperties(func);
  const typeName = generateTypeName(funcName);
  const params = buildParams(func);
  const docstring = buildDocstring(func);
  const decorator = buildToolOptionsDecorator(func);

  // Routing fields only exist on node functions; global functions have neither.
  const decision = "decision" in func ? func.decision : undefined;
  const nextNodeId = "next_node_id" in func ? func.next_node_id : undefined;

  // Decision functions: run the action block, then branch to a next node.
  if (decision) {
    let body = `${INDENT}# Execute action (must set the 'result' variable)\n${decision.action
      .split("\n")
      .map((line) => `${INDENT}${line}`)
      .join("\n")}\n\n`;

    if (decision.conditions.length > 0) {
      body += `${INDENT}# Conditional routing\n`;
      decision.conditions.forEach((condition, index) => {
        const keyword = index === 0 ? "if" : "elif";
        let conditionExpr: string;
        if (condition.operator === "not") {
          conditionExpr = "not result";
        } else if (condition.operator === "in") {
          conditionExpr = `result in ${condition.value}`;
        } else if (condition.operator === "not in") {
          conditionExpr = `result not in ${condition.value}`;
        } else {
          conditionExpr = `result ${condition.operator} ${condition.value}`;
        }
        body += `${INDENT}${keyword} ${conditionExpr}:\n${INDENT}${INDENT}return result, create_${condition.next_node_id}_node()\n`;
      });
      body += `${INDENT}else:\n${INDENT}${INDENT}return result, create_${decision.default_next_node_id}_node()`;
    } else {
      body += `${INDENT}return result, create_${decision.default_next_node_id}_node()`;
    }

    return `${decorator}async def ${funcName}(flow_manager: FlowManager${params}) -> tuple[Any, NodeConfig]:
${docstring}
${body}`;
  }

  // Plain functions: optionally produce a result and route to a next node.
  const resultType = hasType ? typeName : "None";
  const nextType = nextNodeId ? "NodeConfig" : "None";

  let resultValue: string;
  if (hasType) {
    const namedParams = orderedKeys(func)
      .map(({ key }) => `${key}=${key}`)
      .join(", ");
    resultValue = `${typeName}(${namedParams})`;
  } else {
    resultValue = "None";
  }
  const nextValue = nextNodeId ? `create_${nextNodeId}_node()` : "None";

  return `${decorator}async def ${funcName}(flow_manager: FlowManager${params}) -> tuple[${resultType}, ${nextType}]:
${docstring}
${INDENT}# TODO: Implement function logic
${INDENT}# Update flow_manager.state as needed
${INDENT}return ${resultValue}, ${nextValue}`;
}

function formatActions(actions: { type: string; handler?: string; text?: string }[]): string {
  const actionStrs = actions.map((action) => {
    if (action.type === "end_conversation") {
      return `            {"type": "end_conversation"}`;
    } else if (action.type === "function" && action.handler) {
      return `            {"type": "function", "handler": ${action.handler}}`;
    } else if (action.type === "tts_say" && action.text) {
      return `            {"type": "tts_say", "text": "${escapePythonString(action.text)}"}`;
    }
    return `            {"type": "${action.type}"}`;
  });
  return actionStrs.join(",\n");
}

// Generate the create_<id>_node() factory for a single node.
function generateNodeFactory(node: FlowNodeJson): string {
  const nodeId = node.id;
  const data = node.data || {};

  const roleMessages = (data.role_messages as MessageJson[] | undefined) || [];
  const taskMessages = (data.task_messages as MessageJson[] | undefined) || [];
  const functions = (data.functions as FlowFunctionJson[] | undefined) || [];
  const preActions = data.pre_actions || [];
  const postActions = data.post_actions || [];
  const contextStrategy = data.context_strategy as
    | { strategy: "APPEND" | "RESET" | "RESET_WITH_SUMMARY"; summary_prompt?: string }
    | undefined;

  let code = `def create_${nodeId}_node() -> NodeConfig:
    """Create the ${data.label || nodeId} node."""
    return NodeConfig(
        name="${nodeId}",
`;

  // `role_message` (str) replaces the deprecated `role_messages` (list). Collapse
  // any role messages into a single system instruction string.
  if (roleMessages.length > 0) {
    const roleContent = roleMessages.map((m) => m.content).join("\n\n");
    code += `        role_message=${pythonStringLiteral(roleContent)},\n`;
  }

  if (taskMessages.length > 0) {
    code += `        task_messages=[\n${taskMessages.map(formatMessage).join(",\n")}\n        ],\n`;
  }

  if (functions.length > 0) {
    code += `        functions=[${functions.map((f) => f.name).join(", ")}],\n`;
  }

  if (preActions.length > 0) {
    code += `        pre_actions=[\n${formatActions(preActions)}\n        ],\n`;
  }

  if (postActions.length > 0) {
    code += `        post_actions=[\n${formatActions(postActions)}\n        ],\n`;
  }

  if (contextStrategy && contextStrategy.strategy !== "APPEND") {
    if (contextStrategy.strategy === "RESET_WITH_SUMMARY") {
      const summaryPrompt = contextStrategy.summary_prompt
        ? escapePythonString(contextStrategy.summary_prompt)
        : "";
      code += `        context_strategy=ContextStrategyConfig(\n            strategy=ContextStrategy.${contextStrategy.strategy},\n            summary_prompt="${summaryPrompt}",\n        ),\n`;
    } else {
      code += `        context_strategy=ContextStrategyConfig(\n            strategy=ContextStrategy.${contextStrategy.strategy}\n        ),\n`;
    }
  }

  // respond_immediately defaults to True; only emit it when False.
  if (data.respond_immediately === false) {
    code += `        respond_immediately=False,\n`;
  }

  code += `    )`;

  return code;
}

export function generatePythonCode(flow: FlowJson): string {
  const nodes = flow.nodes || [];
  const globalFuncs = flow.global_functions || [];
  const initialNode = nodes.find((n) => n.type === "initial");
  const initialNodeId = initialNode?.id || nodes[0]?.id || "initial";

  // Determine which optional imports are needed.
  const hasContextStrategy = nodes.some(
    (node) => node.data?.context_strategy && node.data.context_strategy.strategy !== "APPEND"
  );
  const allNodeFunctions = nodes.flatMap(
    (node) => (node.data?.functions as FlowFunctionJson[] | undefined) || []
  );
  const hasDecision = allNodeFunctions.some((func) => func.decision !== undefined);

  // Collect result TypedDefs, de-duplicated by type name (first occurrence wins,
  // matching the function-body dedup below; globals come first). Decision
  // functions return `Any` (the action's `result`), so they get no result type.
  const typeDefs = new Map<string, string>();
  for (const func of [...globalFuncs, ...allNodeFunctions]) {
    const isDecision = "decision" in func && Boolean(func.decision);
    const typeName = generateTypeName(func.name);
    if (hasProperties(func) && !isDecision && !typeDefs.has(typeName)) {
      typeDefs.set(typeName, generateTypeDefinition(func));
    }
  }

  // Imports
  const typingImports = [hasDecision ? "Any" : null, typeDefs.size > 0 ? "TypedDict" : null].filter(
    Boolean
  );
  const flowsImports = ["FlowManager", "NodeConfig"];
  if (hasContextStrategy) {
    flowsImports.push("ContextStrategy", "ContextStrategyConfig");
  }
  if ([...globalFuncs, ...allNodeFunctions].some(usesToolOptions)) {
    flowsImports.push("flows_tool_options");
  }

  // Each entry below is a top-level block; blocks are joined with two blank
  // lines (PEP 8) when assembled at the end.
  const blocks: string[] = [];

  const moduleDocstring = `"""Generated Pipecat Flow: ${flow.meta.name}

This file was generated from the visual flow editor.

Functions are defined as pipecat-flows "direct functions": their schemas are
extracted automatically from each function's signature and docstring. Fill in
the function bodies to implement your flow logic.
"""`;
  blocks.push(moduleDocstring);

  let importBlock = "";
  if (typingImports.length > 0) {
    importBlock += `from typing import ${typingImports.join(", ")}\n\n`;
  }
  importBlock += `from pipecat_flows import (\n${flowsImports.map((i) => `    ${i},`).join("\n")}\n)`;
  blocks.push(importBlock);

  // Result type definitions
  if (typeDefs.size > 0) {
    blocks.push(`# Type definitions\n${Array.from(typeDefs.values()).join("\n\n\n")}`);
  }

  // Global functions (direct functions registered on every node).
  if (globalFuncs.length > 0) {
    const globals = globalFuncs.map((func) => generateDirectFunction(func)).join("\n\n\n");
    blocks.push(`# Global functions (available at every node)\n${globals}`);
  }

  // Node functions (direct functions), grouped per node and de-duplicated by
  // name so shared functions are defined only once. Global function names are
  // seeded so a node function never redefines a global of the same name.
  const emitted = new Set<string>(globalFuncs.map((f) => f.name));
  for (const node of nodes) {
    const functions = (node.data?.functions as FlowFunctionJson[] | undefined) || [];
    const fresh = functions.filter((func) => !emitted.has(func.name));
    if (fresh.length === 0) continue;
    const label = node.data?.label || node.id;
    const groupFns = fresh
      .map((func) => {
        emitted.add(func.name);
        return generateDirectFunction(func);
      })
      .join("\n\n\n");
    blocks.push(`# Functions for the ${label} node\n${groupFns}`);
  }

  // Node creation functions
  blocks.push(`# Node creation functions\n${nodes.map(generateNodeFactory).join("\n\n\n")}`);

  // FlowManager setup (commented scaffold).
  const globalFuncRefs = globalFuncs.map((f) => f.name).join(", ");
  const globalFuncsLine =
    globalFuncs.length > 0
      ? `#         global_functions=[${globalFuncRefs}],`
      : `#         # global_functions=[...],`;

  blocks.push(`# FlowManager Setup
#
# Wire the generated nodes into your Pipecat bot:
#
# async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
#     stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))
#     tts = CartesiaTTSService(api_key=os.getenv("CARTESIA_API_KEY"))
#     llm = OpenAILLMService(api_key=os.getenv("OPENAI_API_KEY"))
#
#     context = LLMContext()
#     context_aggregator = LLMContextAggregatorPair(context)
#
#     pipeline = Pipeline([
#         transport.input(),
#         stt,
#         context_aggregator.user(),
#         llm,
#         tts,
#         transport.output(),
#         context_aggregator.assistant(),
#     ])
#
#     worker = PipelineWorker(pipeline, params=PipelineParams(enable_metrics=True))
#
#     # Initialize the FlowManager
#     flow_manager = FlowManager(
#         worker=worker,
#         llm=llm,
#         context_aggregator=context_aggregator,
#         transport=transport,
${globalFuncsLine}
#     )
#
#     @transport.event_handler("on_client_connected")
#     async def on_client_connected(transport, client):
#         # Kick off the conversation with the initial node
#         await flow_manager.initialize(create_${initialNodeId}_node())
#
#     runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
#     await runner.add_workers(worker)
#     await runner.run()`);

  return blocks.join("\n\n\n") + "\n";
}
