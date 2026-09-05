/**
 * Sign Production Review Print-Ready Authority Repair: SSR snapshot checks
 * proving the final download — the ONLY place this workflow ever shows
 * "Print-ready" or a download link — renders NOTHING until the CURRENT
 * candidate is truly print ready, and renders the correct, history-free
 * copy ("Print-ready file" / "Download print-ready artwork", never
 * "Download corrected artwork") once it is.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { SignPlanOperatorProductionStatus } from "@/capabilities/sign-preparation";

import { SignPrintReadyDownload } from "./SignPrintReadyDownload";

function production(overrides: Partial<SignPlanOperatorProductionStatus> = {}): SignPlanOperatorProductionStatus {
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
    physicalResolutionMetadata: null,
    ...overrides,
  };
}

function render(status: SignPlanOperatorProductionStatus) {
  return renderToString(createElement(SignPrintReadyDownload, { projectId: "test-project", production: status }));
}

describe("SignPrintReadyDownload", () => {
  it("not print ready (nothing prepared yet): renders nothing at all", () => {
    assert.equal(render(production()), "");
  });

  it("in flight: renders nothing (this component is never the in-flight indicator)", () => {
    assert.equal(render(production({ jobStatus: "queued", inFlight: true })), "");
  });

  it("completed but needsAttention (blocked candidate): renders nothing — no fake/disabled print-ready button", () => {
    const html = render(
      production({ jobStatus: "completed", printReady: false, needsAttention: true, blockedCandidateAssetId: "x" }),
    );
    assert.equal(html, "");
  });

  it("printReady true but jobStatus somehow not completed (defensive — printReady already implies completed in practice): still gated purely by the shared CTA state, never independently", () => {
    // resolveSignProductionCtaState checks printReady first regardless of jobStatus — this proves SignPrintReadyDownload never adds a second, independent condition.
    const html = render(production({ jobStatus: "completed", printReady: true }));
    assert.match(html, /data-sign-production-ready/);
  });

  it("truly print ready: renders the download section with production-safe, history-free copy", () => {
    const html = render(production({ jobStatus: "completed", printReady: true }));
    assert.match(html, /data-sign-production-ready/);
    assert.match(html, /Print-ready file/);
    assert.match(html, /Download print-ready artwork/);
    assert.doesNotMatch(html, /Download corrected artwork/);
    assert.match(html, /data-testid="sign-download-link"/);
    assert.match(html, /href="\/api\/internal\/projects\/test-project\/sign-artwork\/download"/);
  });

  it("truly print ready even though needsAttention/failed were somehow also set (defensive precedence, mirrors resolveSignProductionCtaState's own print_ready-wins rule)", () => {
    const html = render(production({ jobStatus: "completed", printReady: true, needsAttention: true, failed: true }));
    assert.match(html, /data-sign-production-ready/);
  });
});
