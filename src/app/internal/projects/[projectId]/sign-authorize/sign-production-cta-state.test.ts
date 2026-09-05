import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

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

test("exactly one of print_ready/in_flight/action/needs_qr_resolution — never a combined or ambiguous result", () => {
  const cases: Partial<SignPlanOperatorProductionStatus>[] = [
    {},
    { jobStatus: "queued", inFlight: true },
    { jobStatus: "completed", printReady: true },
    { jobStatus: "failed", failed: true },
    { jobStatus: "completed", needsAttention: true },
    {
      jobStatus: "completed",
      needsAttention: true,
      machineReadableContent: { regions: [], overall: "review_required" },
    },
  ];
  for (const overrides of cases) {
    const cta = resolveSignProductionCtaState(production(overrides));
    const kinds = ["print_ready", "in_flight", "action", "needs_qr_resolution"].filter((k) => k === cta.kind);
    assert.equal(kinds.length, 1, `exactly one kind for ${JSON.stringify(overrides)}`);
  }
});

describe("Fix QR Review UX Phase (real Get Hibachi acceptance incident: 'Try again' rendered above an unresolved QR review panel)", () => {
  it("CASE D — real Get Hibachi shape: candidate exists, fit READY, machine-readable review_required: needs_qr_resolution, NEVER try_again", () => {
    const cta = resolveSignProductionCtaState(
      production({
        jobStatus: "completed",
        printReady: false,
        needsAttention: true,
        blockedCandidateAssetId: null, // completeWithoutAsset-shaped completion is not required for this — evidence alone decides
        fitToProduction: { status: "pass", reason: "all edges clear", safeInsetIn: 0.125, achievedPpiX: 170.67, achievedPpiY: 170.67, edges: [] },
        machineReadableContent: {
          regions: [{ id: "qr-1", kind: "qr", sourceDecodable: false, sourcePayloadSha256: null, candidateDecodable: false, candidatePayloadSha256: null, result: "review_required", provenance: null, regionKey: "abc123" }],
          overall: "review_required",
        },
      }),
    );
    assert.deepEqual(cta, { kind: "needs_qr_resolution" });
  });

  it("CASE E — machine-readable fail (source decoded, candidate lost it): needs_qr_resolution, NEVER try_again — restoration is the correct path, not execution retry", () => {
    const cta = resolveSignProductionCtaState(
      production({
        jobStatus: "completed",
        needsAttention: true,
        machineReadableContent: { regions: [], overall: "fail" },
      }),
    );
    assert.deepEqual(cta, { kind: "needs_qr_resolution" });
  });

  it("machine-readable hard_fail (candidate decodes a DIFFERENT payload): needs_qr_resolution, NEVER try_again", () => {
    const cta = resolveSignProductionCtaState(
      production({
        jobStatus: "completed",
        needsAttention: true,
        machineReadableContent: { regions: [], overall: "hard_fail" },
      }),
    );
    assert.deepEqual(cta, { kind: "needs_qr_resolution" });
  });

  it("CASE C protection — needsAttention for an UNRELATED reason (machineReadableContent not_applicable) still gets try_again, unaffected", () => {
    const cta = resolveSignProductionCtaState(
      production({
        jobStatus: "completed",
        needsAttention: true,
        blockedCandidateAssetId: "candidate-asset-id",
        machineReadableContent: { regions: [], overall: "not_applicable" },
      }),
    );
    assert.deepEqual(cta, { kind: "action", label: "try_again", needsAttentionNotice: true });
  });

  it("machine-readable pass never triggers needs_qr_resolution, even if needsAttention is somehow also true for an unrelated reason", () => {
    const cta = resolveSignProductionCtaState(
      production({
        jobStatus: "completed",
        needsAttention: true,
        machineReadableContent: { regions: [], overall: "pass" },
      }),
    );
    assert.deepEqual(cta, { kind: "action", label: "try_again", needsAttentionNotice: true });
  });

  it("machine-readable accepted_as_supplied never triggers needs_qr_resolution", () => {
    const cta = resolveSignProductionCtaState(
      production({
        jobStatus: "completed",
        needsAttention: true,
        machineReadableContent: { regions: [], overall: "accepted_as_supplied" },
      }),
    );
    assert.deepEqual(cta, { kind: "action", label: "try_again", needsAttentionNotice: true });
  });

  it("CASE B protection (commit 70c46cd retry revival, Section T): a genuinely failed job never has machine-readable evidence (null) and always still gets try_again", () => {
    const cta = resolveSignProductionCtaState(
      production({ jobStatus: "failed", failed: true, machineReadableContent: null }),
    );
    assert.deepEqual(cta, { kind: "action", label: "try_again", needsAttentionNotice: false });
  });

  it("needs_qr_resolution never renders when print-ready or in-flight take precedence (defensive precedence, mirrors the print_ready test above)", () => {
    const blockingEvidence = { regions: [], overall: "review_required" as const };
    assert.deepEqual(
      resolveSignProductionCtaState(
        production({ jobStatus: "completed", printReady: true, needsAttention: true, machineReadableContent: blockingEvidence }),
      ),
      { kind: "print_ready" },
    );
    assert.deepEqual(
      resolveSignProductionCtaState(
        production({ jobStatus: "queued", inFlight: true, machineReadableContent: blockingEvidence }),
      ),
      { kind: "in_flight" },
    );
  });
});
