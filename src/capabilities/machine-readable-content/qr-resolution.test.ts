import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import type {
  MachineReadablePreservationInstance,
  MachineReadablePreservationReport,
} from "./contracts";
import { applyQrResolutions, deriveRegionKey, type SignQrResolutionRecord } from "./qr-resolution";

const SOURCE = { assetId: "asset-1", sha256: "a".repeat(64) };
const OTHER_SOURCE = { assetId: "asset-2", sha256: "b".repeat(64) };

function reviewRequiredInstance(overrides: Partial<MachineReadablePreservationInstance> = {}): MachineReadablePreservationInstance {
  return {
    id: "qr-1",
    kind: "qr",
    sourceBounds: { xPx: 1200, yPx: 800, widthPx: 320, heightPx: 220 },
    sourceDecodable: false,
    sourcePayloadSha256: null,
    candidateBounds: null,
    candidateDecodable: false,
    candidatePayloadSha256: null,
    result: "review_required",
    provenance: null,
    regionKey: deriveRegionKey({ xPx: 1200, yPx: 800, widthPx: 320, heightPx: 220 }),
    sourceLocalizationConfidence: "high",
    sourceFinderCenters: [],
    ...overrides,
  };
}

function reportOf(instance: MachineReadablePreservationInstance): MachineReadablePreservationReport {
  return { instances: [instance], overall: instance.result };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// --- deriveRegionKey ---------------------------------------------------
test("deriveRegionKey: identical bounds produce identical keys", () => {
  const a = deriveRegionKey({ xPx: 1200, yPx: 800, widthPx: 320, heightPx: 220 });
  const b = deriveRegionKey({ xPx: 1200, yPx: 800, widthPx: 320, heightPx: 220 });
  assert.equal(a, b);
});

test("deriveRegionKey: trivial sub-8px jitter between repeated detection runs still resolves to the same key", () => {
  // Base values chosen well clear of an 8px rounding boundary in every
  // dimension, so a small +/-2px jitter can never flip which bucket it
  // rounds into.
  const a = deriveRegionKey({ xPx: 1200, yPx: 800, widthPx: 320, heightPx: 224 });
  const b = deriveRegionKey({ xPx: 1202, yPx: 798, widthPx: 321, heightPx: 226 });
  assert.equal(a, b);
});

test("deriveRegionKey: a genuinely different region produces a different key", () => {
  const a = deriveRegionKey({ xPx: 1200, yPx: 800, widthPx: 320, heightPx: 220 });
  const b = deriveRegionKey({ xPx: 100, yPx: 100, widthPx: 320, heightPx: 220 });
  assert.notEqual(a, b);
});

// --- unresolved: no matching record -------------------------------------
test("unresolved: no resolution record at all — stays review_required, blocking", () => {
  const raw = reportOf(reviewRequiredInstance());
  const { report, pendingCorrections } = applyQrResolutions(raw, [], SOURCE);
  assert.equal(report.overall, "review_required");
  assert.equal(report.instances[0].result, "review_required");
  assert.equal(pendingCorrections.length, 0);
});

// --- print_as_supplied ---------------------------------------------------
test("print_as_supplied: becomes accepted_as_supplied, never pass", () => {
  const instance = reviewRequiredInstance();
  const resolution: SignQrResolutionRecord = {
    sourceAssetId: SOURCE.assetId,
    sourceSha256: SOURCE.sha256,
    regionKey: instance.regionKey!,
    state: "print_as_supplied",
    confirmedPayload: null,
    confirmedBy: "customer",
    confirmedAt: new Date().toISOString(),
  };
  const { report } = applyQrResolutions(reportOf(instance), [resolution], SOURCE);
  assert.equal(report.instances[0].result, "accepted_as_supplied");
  assert.equal(report.instances[0].provenance, "print_as_supplied");
  assert.notEqual(report.instances[0].result, "pass");
  assert.equal(report.overall, "accepted_as_supplied");
});

// --- confirmed_destination: candidate already matches --------------------
test("confirmed_destination: candidate already decodes exactly the confirmed payload — pass, provenance confirmed_by_user", () => {
  const payload = "https://get-hibachi.com/book";
  const instance = reviewRequiredInstance({
    candidateDecodable: true,
    candidatePayloadSha256: sha256Hex(payload),
  });
  const resolution: SignQrResolutionRecord = {
    sourceAssetId: SOURCE.assetId,
    sourceSha256: SOURCE.sha256,
    regionKey: instance.regionKey!,
    state: "confirmed_destination",
    confirmedPayload: payload,
    confirmedBy: "customer",
    confirmedAt: new Date().toISOString(),
  };
  const { report, pendingCorrections } = applyQrResolutions(reportOf(instance), [resolution], SOURCE);
  assert.equal(report.instances[0].result, "pass");
  assert.equal(report.instances[0].provenance, "confirmed_by_user");
  assert.equal(pendingCorrections.length, 0);
});

// --- confirmed_destination: candidate does not yet match ------------------
test("confirmed_destination: candidate does NOT yet decode the confirmed payload — stays review_required, reported as a pending correction", () => {
  const instance = reviewRequiredInstance({ candidateDecodable: false, candidatePayloadSha256: null });
  const resolution: SignQrResolutionRecord = {
    sourceAssetId: SOURCE.assetId,
    sourceSha256: SOURCE.sha256,
    regionKey: instance.regionKey!,
    state: "confirmed_destination",
    confirmedPayload: "https://get-hibachi.com/book",
    confirmedBy: "customer",
    confirmedAt: new Date().toISOString(),
  };
  const { report, pendingCorrections } = applyQrResolutions(reportOf(instance), [resolution], SOURCE);
  assert.equal(report.instances[0].result, "review_required");
  assert.equal(pendingCorrections.length, 1);
  assert.equal(pendingCorrections[0].resolution.confirmedPayload, "https://get-hibachi.com/book");
});

// --- stale evidence: resolution bound to a DIFFERENT source never applies ---
test("stale evidence: a resolution record bound to a different source asset never governs the current instance", () => {
  const instance = reviewRequiredInstance();
  const resolution: SignQrResolutionRecord = {
    sourceAssetId: OTHER_SOURCE.assetId, // a different source entirely
    sourceSha256: OTHER_SOURCE.sha256,
    regionKey: instance.regionKey!,
    state: "print_as_supplied",
    confirmedPayload: null,
    confirmedBy: "customer",
    confirmedAt: new Date().toISOString(),
  };
  const { report } = applyQrResolutions(reportOf(instance), [resolution], SOURCE);
  assert.equal(report.instances[0].result, "review_required", "a stale resolution for a different source must never apply");
});

test("stale evidence: a resolution record with a different regionKey never governs an unrelated region", () => {
  const instance = reviewRequiredInstance();
  const resolution: SignQrResolutionRecord = {
    sourceAssetId: SOURCE.assetId,
    sourceSha256: SOURCE.sha256,
    regionKey: deriveRegionKey({ xPx: 0, yPx: 0, widthPx: 50, heightPx: 50 }), // unrelated region
    state: "print_as_supplied",
    confirmedPayload: null,
    confirmedBy: "customer",
    confirmedAt: new Date().toISOString(),
  };
  const { report } = applyQrResolutions(reportOf(instance), [resolution], SOURCE);
  assert.equal(report.instances[0].result, "review_required");
});

// --- pass/fail/hard_fail/not_applicable pass through unchanged -----------
test("a pass/fail/hard_fail/not_applicable instance is never touched by resolution application", () => {
  for (const result of ["pass", "fail", "hard_fail"] as const) {
    const instance: MachineReadablePreservationInstance = {
      id: "qr-1",
      kind: "qr",
      sourceBounds: { xPx: 0, yPx: 0, widthPx: 10, heightPx: 10 },
      sourceDecodable: true,
      sourcePayloadSha256: "x".repeat(64),
      candidateBounds: null,
      candidateDecodable: result === "fail" ? false : true,
      candidatePayloadSha256: result === "fail" ? null : "y".repeat(64),
      result,
      provenance: result === "pass" ? "verified_from_source_qr" : null,
      regionKey: deriveRegionKey({ xPx: 0, yPx: 0, widthPx: 10, heightPx: 10 }),
      sourceLocalizationConfidence: null,
      sourceFinderCenters: [],
    };
    const resolution: SignQrResolutionRecord = {
      sourceAssetId: SOURCE.assetId,
      sourceSha256: SOURCE.sha256,
      regionKey: instance.regionKey!,
      state: "print_as_supplied",
      confirmedPayload: null,
      confirmedBy: "customer",
      confirmedAt: new Date().toISOString(),
    };
    const { report } = applyQrResolutions({ instances: [instance], overall: result }, [resolution], SOURCE);
    assert.equal(report.instances[0].result, result, `${result} must never be altered by a resolution record`);
  }
});

test("not_applicable (no instances at all) is unaffected by resolution records", () => {
  const raw: MachineReadablePreservationReport = { instances: [], overall: "not_applicable" };
  const { report, pendingCorrections } = applyQrResolutions(raw, [], SOURCE);
  assert.equal(report.overall, "not_applicable");
  assert.equal(pendingCorrections.length, 0);
});

// --- multiple QR regions resolve independently ----------------------------
test("multiple QR regions: independent resolutions never bleed into each other", () => {
  const instanceA = reviewRequiredInstance({
    id: "qr-1",
    sourceBounds: { xPx: 100, yPx: 100, widthPx: 50, heightPx: 50 },
    regionKey: deriveRegionKey({ xPx: 100, yPx: 100, widthPx: 50, heightPx: 50 }),
  });
  const instanceB = reviewRequiredInstance({
    id: "qr-2",
    sourceBounds: { xPx: 900, yPx: 900, widthPx: 50, heightPx: 50 },
    regionKey: deriveRegionKey({ xPx: 900, yPx: 900, widthPx: 50, heightPx: 50 }),
  });
  const resolutionA: SignQrResolutionRecord = {
    sourceAssetId: SOURCE.assetId,
    sourceSha256: SOURCE.sha256,
    regionKey: instanceA.regionKey!,
    state: "print_as_supplied",
    confirmedPayload: null,
    confirmedBy: "customer",
    confirmedAt: new Date().toISOString(),
  };
  const raw: MachineReadablePreservationReport = {
    instances: [instanceA, instanceB],
    overall: "review_required",
  };
  const { report } = applyQrResolutions(raw, [resolutionA], SOURCE);
  const a = report.instances.find((i) => i.id === "qr-1")!;
  const b = report.instances.find((i) => i.id === "qr-2")!;
  assert.equal(a.result, "accepted_as_supplied");
  assert.equal(b.result, "review_required", "an unrelated region's resolution must never apply to a different region");
  assert.equal(report.overall, "review_required", "overall reflects the worst instance");
});
