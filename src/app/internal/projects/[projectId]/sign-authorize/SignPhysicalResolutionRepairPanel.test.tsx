/**
 * Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair
 * Phase: SSR snapshot checks proving the "Fix print size metadata" action
 * is visible exactly when it should be, and never before — mirrors
 * `SignQrPreservationPanel.test.tsx`'s own established pattern
 * (`renderToString` + a fake `AppRouterInstance` via `AppRouterContext`).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { SignPhysicalResolutionMetadataSummary } from "@/capabilities/sign-preparation";

import { SignPhysicalResolutionRepairPanel } from "./SignPhysicalResolutionRepairPanel";

/** Minimal fake `AppRouterInstance` — this component only ever calls `refresh()`, and only from a click handler that never fires during a static SSR snapshot. */
const fakeRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => Promise.resolve(),
};

function render(physicalResolutionMetadata: SignPhysicalResolutionMetadataSummary | null) {
  return renderToString(
    createElement(
      AppRouterContext.Provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake, real type is Next-internal
      { value: fakeRouter as any },
      createElement(SignPhysicalResolutionRepairPanel, { projectId: "test-project", physicalResolutionMetadata }),
    ),
  );
}

describe("SignPhysicalResolutionRepairPanel: 'Fix print size metadata' visibility", () => {
  it("pass: no button, correct-status copy, no raw internal vocabulary", () => {
    const html = render({ status: "pass", reason: "agrees with the ordered size" });
    assert.doesNotMatch(html, /data-testid="sign-physical-resolution-repair-button"/);
    assert.match(html, /data-sign-physical-resolution-status="pass"/);
    assert.doesNotMatch(html, /pHYs/);
    assert.doesNotMatch(html, /physical_resolution_metadata/);
  });

  it("fail: the button is present, with production-safe copy — never 'pHYs'", () => {
    const html = render({ status: "fail", reason: "declares the wrong PPI" });
    assert.match(html, /data-testid="sign-physical-resolution-repair-button"/);
    assert.match(html, /Fix print size metadata/);
    assert.match(html, /data-sign-physical-resolution-status="fail"/);
    assert.doesNotMatch(html, /pHYs/);
  });

  it("null (never evaluated for this check — e.g. a validation persisted before it existed, the real historical Get Hibachi shape): the button is STILL offered, never silently hidden", () => {
    const html = render(null);
    assert.match(html, /data-testid="sign-physical-resolution-repair-button"/);
    assert.match(html, /data-sign-physical-resolution-status="not_checked"/);
    assert.match(html, /Not yet verified for this candidate\./);
  });

  it("an unrecognized status string is treated as needing the fix, never silently hidden", () => {
    const html = render({ status: "unknown", reason: "geometry incomplete" });
    assert.match(html, /data-testid="sign-physical-resolution-repair-button"/);
  });
});
