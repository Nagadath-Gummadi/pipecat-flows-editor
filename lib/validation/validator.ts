import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

import { type FlowJson, getCompiledJsonSchema } from "@/lib/schema/flow.schema";

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
addFormats(ajv);

const flowSchema = getCompiledJsonSchema();
ajv.addSchema(flowSchema, flowSchema.$id as string);

const validateFlow =
  ajv.getSchema<FlowJson>(flowSchema.$id as string) ?? ajv.compile<FlowJson>(flowSchema);

export type ValidationResult = {
  valid: boolean;
  errors: ErrorObject[] | null | undefined;
};

export function validateFlowJson(json: unknown): ValidationResult {
  const isValid = validateFlow(json);
  return { valid: Boolean(isValid), errors: validateFlow.errors };
}

// Deterministic stringify (object keys sorted) so two structurally identical
// definitions compare equal regardless of property order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function customGraphChecks(flow: FlowJson): ErrorObject[] {
  const errors: ErrorObject[] = [];
  // Unique node ids
  const ids = new Set<string>();
  for (const n of flow.nodes) {
    if (ids.has(n.id)) {
      errors.push({
        instancePath: `/nodes/${n.id}`,
        schemaPath: "#/uniqueNodeIds",
        keyword: "uniqueNodeId",
        params: { id: n.id },
        message: `Duplicate node id: ${n.id}`,
      } as ErrorObject);
    }
    ids.add(n.id);
  }
  // Edge endpoints exist
  const nodeIds = new Set(flow.nodes.map((n) => n.id));
  flow.edges.forEach((e, i) => {
    if (!nodeIds.has(e.source)) {
      errors.push({
        instancePath: `/edges/${i}/source`,
        schemaPath: "#/edgeSourceExists",
        keyword: "edgeSourceExists",
        params: { source: e.source },
        message: `Edge source not found: ${e.source}`,
      } as ErrorObject);
    }
    if (!nodeIds.has(e.target)) {
      errors.push({
        instancePath: `/edges/${i}/target`,
        schemaPath: "#/edgeTargetExists",
        keyword: "edgeTargetExists",
        params: { target: e.target },
        message: `Edge target not found: ${e.target}`,
      } as ErrorObject);
    }
  });

  // Functions that share a name must share a definition. Code generation emits a
  // single Python `async def` per name (the same function can legitimately be
  // referenced from multiple nodes), so two same-named functions with differing
  // definitions would silently drop the later one.
  const fnSignatures = new Map<string, string>();
  const checkFunction = (fn: unknown, instancePath: string) => {
    const name = (fn as { name?: string })?.name;
    if (!name) return;
    const signature = stableStringify(fn);
    const existing = fnSignatures.get(name);
    if (existing === undefined) {
      fnSignatures.set(name, signature);
    } else if (existing !== signature) {
      errors.push({
        instancePath,
        schemaPath: "#/uniqueFunctionName",
        keyword: "uniqueFunctionName",
        params: { name },
        message: `Conflicting definitions for function "${name}": functions sharing a name must be identical`,
      } as ErrorObject);
    }
  };
  (flow.global_functions ?? []).forEach((fn, i) => checkFunction(fn, `/global_functions/${i}`));
  flow.nodes.forEach((n) => {
    const functions = (n.data?.functions as unknown[] | undefined) ?? [];
    functions.forEach((fn, i) => checkFunction(fn, `/nodes/${n.id}/functions/${i}`));
  });

  return errors;
}
