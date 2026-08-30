/**
 * Signs Phase S1: canonical repair-plan identity — the future
 * `FinalArtworkJob` binding key (the `production_treatment_key` precedent).
 *
 * Identity covers exactly the PRODUCTION-SIGNIFICANT inputs: what is
 * produced, from which bytes, to which ordered size, by which ordered
 * operations, under which schema and policy. It deliberately EXCLUDES
 * rationale text, risk classes, and defect lists — those explain and gate a
 * plan, but two plans that produce byte-identical work are the same plan.
 * Byte identity of the source is the SHA-256, so re-uploading identical
 * bytes as a new asset row keeps the same plan identity on purpose.
 *
 * Serialization is canonical: recursively sorted object keys, JSON number
 * formatting (stable for equal values), inches fixed to two decimals. A
 * cosmetic reordering of the same plan can never change the key.
 */

import { createHash } from "node:crypto";

import type { SignRepairPlan, SignRepairStep } from "./contracts";
import { SIGN_REPAIR_PLAN_SCHEMA_VERSION } from "./contracts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
    .join(",");
  return `{${body}}`;
}

function canonicalStep(step: SignRepairStep): Json {
  // kind + params only — risk and reasons are gating/rationale, not identity.
  return { kind: step.kind, params: { ...step.params } };
}

export type SignPlanIdentityInput = Pick<
  SignRepairPlan,
  | "policyId"
  | "sourceSha256"
  | "sourceWidthPx"
  | "sourceHeightPx"
  | "orderedWidthIn"
  | "orderedHeightIn"
  | "steps"
  | "expectedOutputWidthPx"
  | "expectedOutputHeightPx"
>;

export function computeSignPlanKey(input: SignPlanIdentityInput): string {
  const payload: Json = {
    schemaVersion: SIGN_REPAIR_PLAN_SCHEMA_VERSION,
    policyId: input.policyId,
    sourceSha256: input.sourceSha256,
    sourceWidthPx: input.sourceWidthPx,
    sourceHeightPx: input.sourceHeightPx,
    orderedWidthIn: input.orderedWidthIn.toFixed(2),
    orderedHeightIn: input.orderedHeightIn.toFixed(2),
    steps: input.steps.map((step) => canonicalStep(step)),
    expectedOutputWidthPx: input.expectedOutputWidthPx,
    expectedOutputHeightPx: input.expectedOutputHeightPx,
  };
  const digest = createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
  return `${SIGN_REPAIR_PLAN_SCHEMA_VERSION}:${digest}`;
}
