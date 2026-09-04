import assert from "node:assert/strict";
import { test } from "node:test";

import type { SignPlanOperatorProductionStatus } from "@/capabilities/sign-preparation";
import { resolveSignProductionCtaState } from "./sign-production-cta-state";

/**
 * FIX AUTHORIZED SIGN PRODUCTION WORKSPACE CTA: regression coverage for the
 * 6-state model this task specified. See `sign-production-cta-state.ts`'s
 * own doc for the real investigation finding — the reported real project
 * (`0858d192-e74e-40b5-8532-a91bc4bcdf8e`) was already showing the CORRECT
 * "Try again" for a genuine failed job, so this is characterization
 * coverage locking in the ALREADY-correct mapping, not a fix.
 */
function production(
  overrides: Partial<SignPlanOperatorProductionStatus> = {},
): SignPlanOperatorProductionStatus {
  return {
    jobStatus: null,
    inFlight: false,
    failed: false,
    printReady: false,
    needsAttention: false,
    blockedCandidateAssetId: null,
    blockedValidationId: null,
    blockedValidationStatus: null,
    fitToProduction: null,
    machineReadableContent: null,
    ...overrides,
  };
}

test("state 2 — authorized, executable, no job at all: prepare_artwork, never try_again", () => {
  const cta = resolveSignProductionCtaState(production({ jobStatus: null }));
  assert.deepEqual(cta, { kind: "action", label: "prepare_artwork", needsAttentionNotice: false });
});

test("state 3 — active job (queued/running/recoverable): in_flight, regardless of any other field", () => {
  for (const jobStatus of ["queued", "running", "recoverable"] as const) {
    const cta = resolveSignProductionCtaState(production({ jobStatus, inFlight: true }));
    assert.deepEqual(cta, { kind: "in_flight" });
  }
});

test("state 4 — completed and print-ready: print_ready, takes precedence over everything else", () => {
  const cta = resolveSignProductionCtaState(
    production({ jobStatus: "completed", printReady: true }),
  );
  assert.deepEqual(cta, { kind: "print_ready" });
});

test("print_ready wins even if inFlight/failed/needsAttention were somehow also set (defensive precedence)", () => {
  const cta = resolveSignProductionCtaState(
    production({ jobStatus: "completed", printReady: true, failed: true, needsAttention: true }),
  );
  assert.deepEqual(cta, { kind: "print_ready" });
});

test("state 5 — a genuinely failed job: try_again, no needs-attention notice — the real project's actual state", () => {
  const cta = resolveSignProductionCtaState(production({ jobStatus: "failed", failed: true }));
  assert.deepEqual(cta, { kind: "action", label: "try_again", needsAttentionNotice: false });
});

test("state 6 — completed but not print-ready (blocked candidate): try_again WITH the needs-attention notice — the existing, protected Wand/correction project behavior (cc6cfc4b)", () => {
  const cta = resolveSignProductionCtaState(
    production({
      jobStatus: "completed",
      printReady: false,
      needsAttention: true,
      blockedCandidateAssetId: "candidate-asset-id",
      blockedValidationId: "validation-id",
      blockedValidationStatus: "finalization_required",
    }),
  );
  assert.deepEqual(cta, { kind: "action", label: "try_again", needsAttentionNotice: true });
});

test("a never-executed project (state 2) never falls into the try_again label (state 5)", () => {
  const cta = resolveSignProductionCtaState(production());
  assert.notEqual(cta.kind === "action" ? cta.label : null, "try_again");
});

test("exactly one of print_ready/in_flight/action — never a combined or ambiguous result", () => {
  const cases: Partial<SignPlanOperatorProductionStatus>[] = [
    {},
    { jobStatus: "queued", inFlight: true },
    { jobStatus: "completed", printReady: true },
    { jobStatus: "failed", failed: true },
    { jobStatus: "completed", needsAttention: true },
  ];
  for (const overrides of cases) {
    const cta = resolveSignProductionCtaState(production(overrides));
    const kinds = ["print_ready", "in_flight", "action"].filter((k) => k === cta.kind);
    assert.equal(kinds.length, 1, `exactly one kind for ${JSON.stringify(overrides)}`);
  }
});
