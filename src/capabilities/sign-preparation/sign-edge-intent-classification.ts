/**
 * Edge-Intent Correction Phase: the GOVERNED, DURABLE half of edge-intent
 * classification — binds a pure `SignEdgeIntentClassification` (geometry +
 * kind, `sign-fit-to-production.ts`'s own concern) to an exact operator
 * decision, candidate/plan identity, and audit trail, and re-validates that
 * binding against CURRENT state before ever trusting a stored record.
 *
 * Deliberately NOT a free-text override (Section F of the governing task):
 * `kind` is a closed, two-member enum. Deliberately NOT bound via a
 * separate plan-key-like identity column — see the migration's own doc for
 * why `analyzeSignFitToProduction` being recomputed fresh every worker run
 * is what "invalidates" a stale classification set in practice; this
 * module's OWN job is narrower: given the CURRENT candidate asset id and
 * plan key, decide which stored records still apply, and strip away every
 * record that does not — never assume, always re-check.
 */

import { randomUUID } from "node:crypto";

import type { SignEdge } from "./contracts";
import type { SignEdgeIntentClassification } from "./sign-fit-to-production";

export type SignEdgeIntentClassificationKind = SignEdgeIntentClassification["kind"];

/**
 * The durable, audit-bound record — what is actually persisted (inside
 * `SignPreparation.edgeIntentClassifications`, one entry per array item).
 * Every field here is either the pure geometry `sign-fit-to-production.ts`
 * needs, or an identity/audit fact this module alone is responsible for
 * checking before that geometry is ever handed to the analysis function.
 */
export interface SignEdgeIntentClassificationRecord {
  id: string;
  kind: SignEdgeIntentClassificationKind;
  edges: SignEdge[];
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  /** The exact production candidate asset this classification was drawn against — a classification for a DIFFERENT (e.g. superseded) candidate must never silently keep applying. */
  candidateAssetId: string;
  /** The exact composition plan key current when this classification was recorded — mirrors `candidateAssetId`'s own reasoning. */
  planKey: string;
  createdAt: string;
  createdBy: "operator";
}

const SIGN_EDGES: readonly SignEdge[] = ["top", "right", "bottom", "left"];

function isSignEdge(value: unknown): value is SignEdge {
  return typeof value === "string" && (SIGN_EDGES as readonly string[]).includes(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Parses one raw JSON entry into a `SignEdgeIntentClassificationRecord`, or `null` on any malformed shape — never guessed, never partially trusted. */
export function decodeEdgeIntentClassificationRecord(raw: unknown): SignEdgeIntentClassificationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "edge_intent" && r.kind !== "protected") return null;
  if (!Array.isArray(r.edges) || r.edges.length === 0 || !r.edges.every(isSignEdge)) return null;
  if (!isFiniteNumber(r.xPx) || !isFiniteNumber(r.yPx) || !isFiniteNumber(r.widthPx) || !isFiniteNumber(r.heightPx)) return null;
  if (r.widthPx <= 0 || r.heightPx <= 0 || r.xPx < 0 || r.yPx < 0) return null;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.candidateAssetId !== "string" || !r.candidateAssetId) return null;
  if (typeof r.planKey !== "string" || !r.planKey) return null;
  if (typeof r.createdAt !== "string" || !r.createdAt) return null;
  if (r.createdBy !== "operator") return null;
  return {
    id: r.id,
    kind: r.kind,
    edges: r.edges as SignEdge[],
    xPx: r.xPx, yPx: r.yPx, widthPx: r.widthPx, heightPx: r.heightPx,
    candidateAssetId: r.candidateAssetId,
    planKey: r.planKey,
    createdAt: r.createdAt,
    createdBy: "operator",
  };
}

/** Decodes a whole persisted array, silently dropping (never throwing on) any malformed entry — a genuinely corrupt one row must never block every other valid one. */
export function decodeEdgeIntentClassificationRecords(raw: unknown): SignEdgeIntentClassificationRecord[] {
  if (!Array.isArray(raw)) return [];
  const decoded: SignEdgeIntentClassificationRecord[] = [];
  for (const entry of raw) {
    const record = decodeEdgeIntentClassificationRecord(entry);
    if (record) decoded.push(record);
  }
  return decoded;
}

export function encodeEdgeIntentClassificationRecord(record: SignEdgeIntentClassificationRecord): Record<string, unknown> {
  return { ...record };
}

/**
 * Builds a brand-new record from an operator's input, stamping identity
 * (`id`, `createdAt`, `createdBy: "operator"`) and binding it to the
 * SUPPLIED current candidate/plan identity — the caller is responsible for
 * resolving that identity fresh, never trusting a client-supplied one.
 */
export function buildEdgeIntentClassificationRecord(input: {
  kind: SignEdgeIntentClassificationKind;
  edges: SignEdge[];
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
  candidateAssetId: string;
  planKey: string;
}): SignEdgeIntentClassificationRecord {
  return {
    id: randomUUID(),
    kind: input.kind,
    edges: input.edges,
    xPx: input.xPx, yPx: input.yPx, widthPx: input.widthPx, heightPx: input.heightPx,
    candidateAssetId: input.candidateAssetId,
    planKey: input.planKey,
    createdAt: new Date().toISOString(),
    createdBy: "operator",
  };
}

/**
 * THE re-validation step every reader (the worker, the preview service)
 * must apply before ever handing stored records to `analyzeSignFitToProduction`:
 * strips every record whose OWN embedded `candidateAssetId`/`planKey` does
 * not match the CURRENT authoritative values, and reduces what survives to
 * the pure geometry+kind shape that module actually consumes. A
 * classification bound to a superseded candidate or plan is treated
 * exactly like one that was never recorded — never silently reinterpreted
 * as still governing a materially different rendered candidate.
 */
export function resolveCurrentEdgeIntentClassifications(
  records: SignEdgeIntentClassificationRecord[],
  currentCandidateAssetId: string,
  currentPlanKey: string,
): SignEdgeIntentClassification[] {
  return records
    .filter((r) => r.candidateAssetId === currentCandidateAssetId && r.planKey === currentPlanKey)
    .map((r) => ({ kind: r.kind, edges: r.edges, xPx: r.xPx, yPx: r.yPx, widthPx: r.widthPx, heightPx: r.heightPx }));
}
