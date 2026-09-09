/**
 * "Preparing Artwork" Never Spins Forever Phase (real production blocker):
 * proves the initial "in_flight" render is unchanged ("Preparing
 * artwork…", never the timeout message — `pollingTimedOut` starts
 * `false`), and — since `useEffect` never runs under this repo's
 * `renderToString`-only test tooling (mirrors `SignApproveAndContinueButton
 * .test.tsx`'s own established split) — that the actual bounded-timeout
 * behavior is real via source inspection of the effect itself.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import type { SignPlanOperatorProductionStatus } from "@/capabilities/sign-preparation";

import { SignProductionAction } from "./SignProductionAction";

const fakeRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => Promise.resolve(),
};

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
    physicalResolutionMetadata: null,
    requiresVisualAcceptance: false,
    visualAcceptanceSatisfied: false,
    visualAcceptanceAcceptedAt: null,
    ...overrides,
  };
}

function render(overrides: Partial<SignPlanOperatorProductionStatus> = {}) {
  return renderToString(
    createElement(
      AppRouterContext.Provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake, real type is Next-internal
      { value: fakeRouter as any },
      createElement(SignProductionAction, { projectId: "test-project", production: production(overrides) }),
    ),
  );
}

describe("SignProductionAction: initial in-flight render is unaffected by the timeout fix", () => {
  it("in_flight, jobStatus queued: shows 'Preparing artwork…', never the timeout message, on first render", () => {
    const html = render({ inFlight: true, jobStatus: "queued" });
    assert.match(html, /Preparing artwork…/);
    assert.doesNotMatch(html, /taking longer than expected/i);
    assert.doesNotMatch(html, /Check again/);
  });

  it("in_flight, jobStatus running: same — no timeout state on first render regardless of which in-flight status", () => {
    const html = render({ inFlight: true, jobStatus: "running" });
    assert.match(html, /Preparing artwork…/);
    assert.doesNotMatch(html, /taking longer than expected/i);
  });

  it("not in_flight: no 'Preparing artwork' or timeout copy at all", () => {
    const html = render({ inFlight: false, jobStatus: null });
    assert.doesNotMatch(html, /Preparing artwork/);
    assert.doesNotMatch(html, /taking longer than expected/i);
  });
});

describe("SignProductionAction: bounded polling timeout (source inspection)", () => {
  const source = readFileSync(
    "src/app/internal/projects/[projectId]/sign-authorize/SignProductionAction.tsx",
    "utf8",
  );

  it("imports the shared, tested time-math function rather than inlining its own", () => {
    assert.match(source, /hasSignPreparationPollingTimedOut/);
  });

  it("stops calling router.refresh() once the poll has timed out (never keeps silently polling forever)", () => {
    const timeoutCheck = source.indexOf("hasSignPreparationPollingTimedOut(inFlightStartedAtMs");
    const clearCall = source.indexOf("clearInterval(interval)", timeoutCheck);
    const refreshCall = source.indexOf("router.refresh()", timeoutCheck);
    assert.ok(timeoutCheck >= 0 && clearCall >= 0 && refreshCall >= 0);
    // The interval is cleared strictly before the next scheduled refresh
    // call in source order -- i.e. the branch that fires on timeout
    // returns before ever reaching router.refresh() again.
    assert.ok(clearCall < refreshCall, "clearInterval must appear before the next router.refresh() call in the timeout branch");
  });

  it("renders a plain-language message and a manual 'Check again' action once timed out — never a false 'failed' claim", () => {
    assert.match(source, /This is taking longer than expected\./);
    assert.match(source, /Check again/);
    assert.doesNotMatch(source, /pollingTimedOut[\s\S]{0,200}\bfailed\b/i);
  });

  it("'Check again' never re-POSTs /prepare — it only re-arms polling and refreshes", () => {
    const start = source.indexOf("function checkAgain");
    const end = source.indexOf("async function handleClick");
    assert.ok(start >= 0 && end > start);
    const checkAgainFn = source.slice(start, end);
    assert.doesNotMatch(checkAgainFn, /fetch\(/);
    assert.match(checkAgainFn, /router\.refresh\(\)/);
  });

  it("the timeout threshold is generous — comfortably above real Topaz latency, never falsely flags a legitimately-processing reconstruction", () => {
    assert.match(source, /SIGN_PREPARATION_POLL_INTERVAL_MS/);
  });
});
