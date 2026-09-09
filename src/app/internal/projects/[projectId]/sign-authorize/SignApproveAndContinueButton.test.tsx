/**
 * Simplify Signs Production Review Phase: proves the ONE primary approval
 * action renders the human-language label (never "Authorize plan"), and
 * — since this repo's test tooling is `renderToString` with no DOM/click
 * simulation (mirrors `SignPhysicalResolutionRepairPanel.test.tsx`'s own
 * established pattern for a `useRouter()`-using client component) — that
 * the underlying fetch sequence really is authorize-then-prepare, gated on
 * the first response's own success, via source inspection of the click
 * handler itself.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { SignApproveAndContinueButton } from "./SignApproveAndContinueButton";

const fakeRouter = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => Promise.resolve(),
};

function render() {
  return renderToString(
    createElement(
      AppRouterContext.Provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only fake, real type is Next-internal
      { value: fakeRouter as any },
      createElement(SignApproveAndContinueButton, { projectId: "test-project" }),
    ),
  );
}

describe("SignApproveAndContinueButton: rendered label and control surface", () => {
  it("renders 'Approve & Continue', never 'Authorize plan'", () => {
    const html = render();
    assert.match(html, />Approve &amp; Continue</);
    assert.doesNotMatch(html, /Authorize plan/);
  });

  it("carries a stable data-testid for production acceptance checks", () => {
    const html = render();
    assert.match(html, /data-testid="sign-approve-and-continue-button"/);
  });

  it("starts enabled (idle phase) — not pre-disabled before any click", () => {
    const html = render();
    const buttonTag = html.match(/<button[^>]*data-testid="sign-approve-and-continue-button"[^>]*>/)?.[0];
    assert.ok(buttonTag);
    assert.doesNotMatch(buttonTag!, /\bdisabled=""/);
  });
});

describe("SignApproveAndContinueButton: authorize-then-prepare ordering (source inspection)", () => {
  const fullSource = readFileSync(
    "src/app/internal/projects/[projectId]/sign-authorize/SignApproveAndContinueButton.tsx",
    "utf8",
  );
  // Scoped to the click handler's own body — the file's doc comment above
  // it also names both route paths in prose, which would otherwise
  // pollute a plain `indexOf` search run against the whole file.
  const source = fullSource.slice(fullSource.indexOf("async function handleClick"));

  it("calls the authorize route before the prepare route", () => {
    const authorizeIndex = source.indexOf("/sign-artwork/authorize");
    const prepareIndex = source.indexOf("/sign-artwork/prepare");
    assert.ok(authorizeIndex >= 0, "sanity: authorize route must be called");
    assert.ok(prepareIndex >= 0, "sanity: prepare route must be called");
    assert.ok(authorizeIndex < prepareIndex, "authorize must be requested before prepare");
  });

  it("never calls prepare before checking the authorize response's own .ok", () => {
    const authorizeOkCheck = source.indexOf("!authorizeRes.ok");
    const prepareCall = source.indexOf("/sign-artwork/prepare");
    assert.ok(authorizeOkCheck >= 0, "sanity: the authorize response must be checked");
    assert.ok(authorizeOkCheck < prepareCall, "the .ok check must precede the prepare call");
  });

  it("returns (never falls through to prepare) when authorization fails", () => {
    // The block that checks `!authorizeRes.ok` must itself contain a
    // `return` before the function reaches the prepare fetch.
    const block = source.slice(source.indexOf("!authorizeRes.ok"), source.indexOf("/sign-artwork/prepare"));
    assert.match(block, /return;/);
  });

  it("shows a distinct message when authorization succeeded but preparation failed — never re-authorizes silently", () => {
    assert.match(source, /We couldn't finish preparing the artwork\. Try again\./);
  });

  it("disables the control for the ENTIRE sequence, not just the first request (guards against a duplicate click starting a second sequence)", () => {
    assert.match(source, /disabled=\{phase !== "idle"\}/);
    assert.match(source, /if \(phase !== "idle"\) return;/);
  });

  it("only navigates (router.refresh) after the prepare request itself succeeded", () => {
    const prepareOkCheck = source.indexOf("!prepareRes.ok");
    const refreshCall = source.indexOf("router.refresh()");
    assert.ok(prepareOkCheck >= 0 && refreshCall >= 0);
    assert.ok(prepareOkCheck < refreshCall, "the prepare .ok check must precede router.refresh()");
  });
});
