/**
 * Fix QR Review UX Phase (real Get Hibachi acceptance incident): SSR
 * snapshot checks proving:
 *
 *   1. the destination input is NEVER prefilled from anything the
 *      component receives — its rendered `value` attribute is always
 *      empty, for every `machineReadableContent` shape this component can
 *      be given (Section C/J/X: no visible-artwork-text/URL inference).
 *   2. "Check QR code" is hidden once evidence already reads
 *      `review_required` (Section O) — resolution actions dominate
 *      instead — but remains visible for every OTHER state (never
 *      checked, pass, fail, hard_fail, accepted_as_supplied,
 *      not_applicable).
 *
 * Same pattern `SignFitToProductionCorrectionTool.test.tsx` already uses
 * (`renderToString` + a fake `AppRouterInstance` via `AppRouterContext`) —
 * this component's own state starts with no in-flight action to click
 * through, so a single initial render already proves both invariants.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { SignMachineReadableContentSummary } from "@/capabilities/sign-preparation";

import { SignQrPreservationPanel } from "./SignQrPreservationPanel";

/** Minimal fake `AppRouterInstance` — this component only ever calls `refresh()`, and only from a click handler that never fires during a static SSR snapshot. */
const fakeRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => Promise.resolve(),
};

function region(
  overrides: Partial<SignMachineReadableContentSummary["regions"][number]> = {},
): SignMachineReadableContentSummary["regions"][number] {
  return {
    id: "qr-1",
    kind: "qr",
    sourceDecodable: false,
    sourcePayloadSha256: null,
    candidateDecodable: false,
    candidatePayloadSha256: null,
    result: "review_required",
    provenance: null,
    regionKey: "abc123",
    ...overrides,
  };
}

function render(machineReadableContent: SignMachineReadableContentSummary | null) {
  return renderToString(
    createElement(
      AppRouterContext.Provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake, real type is Next-internal
      { value: fakeRouter as any },
      createElement(SignQrPreservationPanel, { projectId: "test-project", machineReadableContent }),
    ),
  );
}

describe("SignQrPreservationPanel: destination is never prefilled (Section C/J/X)", () => {
  it("review_required: the destination input's rendered value is empty, regardless of the region's own regionKey/id content", () => {
    const html = render({ regions: [region({ regionKey: "get-hibachi-region-1" })], overall: "review_required" });
    assert.match(html, /data-testid="sign-qr-destination-input"/);
    // The rendered <input> must carry an empty value attribute — never a
    // visible-artwork-text-derived or any other non-empty default.
    assert.match(html, /data-testid="sign-qr-destination-input"[^>]*value=""/);
    assert.doesNotMatch(html, /www\.get-hibachi\.com/i);
    assert.doesNotMatch(html, /get-hibachi\.com/i);
  });

  it("the destination input disables browser autofill (autoComplete=\"off\")", () => {
    const html = render({ regions: [region()], overall: "review_required" });
    assert.match(html, /autoComplete="off"[^>]*data-testid="sign-qr-destination-input"/);
  });

  it("the placeholder invites an explicit operator entry, never a suggested/inferred value", () => {
    const html = render({ regions: [region()], overall: "review_required" });
    assert.match(html, /Enter confirmed QR destination/);
    assert.doesNotMatch(html, /your-website\.com/);
  });
});

describe("SignQrPreservationPanel: 'Check QR code' visibility (Section O)", () => {
  it("never checked (null): Check QR code is present", () => {
    const html = render(null);
    assert.match(html, /data-testid="sign-qr-check-button"/);
    assert.match(html, /Not checked yet for this candidate\./);
  });

  it("review_required: Check QR code is HIDDEN — resolution actions dominate instead", () => {
    const html = render({ regions: [region()], overall: "review_required" });
    assert.doesNotMatch(html, /data-testid="sign-qr-check-button"/);
    assert.match(html, /data-testid="sign-qr-fix-button"/);
    assert.match(html, /data-testid="sign-qr-print-as-supplied-button"/);
    assert.match(html, /We found a QR code, but we couldn.*t verify its destination/);
    assert.match(html, /The QR code could not be verified\. Printing as supplied may result in a QR code that does not scan\./);
  });

  it("fail (source decoded, candidate lost it): Check QR code REMAINS visible alongside Restore QR code", () => {
    const html = render({
      regions: [region({ sourceDecodable: true, candidateDecodable: false, result: "fail" })],
      overall: "fail",
    });
    assert.match(html, /data-testid="sign-qr-check-button"/);
    assert.match(html, /data-testid="sign-qr-restore-button"/);
  });

  it("hard_fail: Check QR code REMAINS visible alongside Restore QR code", () => {
    const html = render({
      regions: [region({ sourceDecodable: true, candidateDecodable: true, result: "hard_fail" })],
      overall: "hard_fail",
    });
    assert.match(html, /data-testid="sign-qr-check-button"/);
    assert.match(html, /data-testid="sign-qr-restore-button"/);
  });

  it("pass: Check QR code remains visible, no resolution panel, no restore action", () => {
    const html = render({
      regions: [region({ sourceDecodable: true, candidateDecodable: true, result: "pass", provenance: "verified_from_source_qr" })],
      overall: "pass",
    });
    assert.match(html, /data-testid="sign-qr-check-button"/);
    assert.doesNotMatch(html, /data-testid="sign-qr-restore-button"/);
    assert.doesNotMatch(html, /data-testid="sign-qr-destination-input"/);
    assert.match(html, /Verified — destination preserved/);
  });

  it("accepted_as_supplied: Check QR code remains visible; copy never claims verification", () => {
    const html = render({
      regions: [region({ result: "accepted_as_supplied", provenance: "print_as_supplied" })],
      overall: "accepted_as_supplied",
    });
    assert.match(html, /data-testid="sign-qr-check-button"/);
    assert.match(html, /Printed as supplied — the QR code was not verified to scan\./);
    assert.doesNotMatch(html, /QR code verified/i);
  });

  it("not_applicable: Check QR code remains visible; no resolution panel", () => {
    const html = render({ regions: [], overall: "not_applicable" });
    assert.match(html, /data-testid="sign-qr-check-button"/);
    assert.doesNotMatch(html, /data-testid="sign-qr-destination-input"/);
    assert.match(html, /No QR code was found in this artwork\./);
  });
});
