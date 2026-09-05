/**
 * Sign Production Review Print-Ready Authority Repair: this page has no
 * existing full-render test harness (`page.tsx` is an async Server
 * Component reading `next/headers` cookies and a live capability graph —
 * no precedent anywhere in this repo mocks that for a full page render).
 * Mirrors `dev-hmr-watch-hygiene.test.ts`'s own established pattern for
 * exactly this situation: a source-level structural assertion, reading the
 * real page source and pinning the ONE invariant that actually matters
 * here — render ORDER — without inventing a new, heavier test-harness
 * pattern this repo does not otherwise use.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("Sign Production Review page: final download position", () => {
  const source = readFileSync(
    "src/app/internal/projects/[projectId]/sign-authorize/page.tsx",
    "utf8",
  );

  it("SignPrintReadyDownload is imported and rendered", () => {
    assert.match(source, /import \{ SignPrintReadyDownload \} from "\.\/SignPrintReadyDownload";/);
    assert.match(source, /<SignPrintReadyDownload\b/);
  });

  it("SignPrintReadyDownload renders AFTER the QR preservation panel", () => {
    const qrIndex = source.indexOf("<SignQrPreservationPanel");
    const downloadIndex = source.indexOf("<SignPrintReadyDownload");
    assert.ok(qrIndex >= 0, "sanity: the QR panel must still be rendered");
    assert.ok(downloadIndex >= 0, "sanity: the download component must be rendered");
    assert.ok(downloadIndex > qrIndex, "the final download must render AFTER the QR panel, never before it");
  });

  it("SignPrintReadyDownload renders AFTER the physical-resolution repair panel", () => {
    const physicalIndex = source.indexOf("<SignPhysicalResolutionRepairPanel");
    const downloadIndex = source.indexOf("<SignPrintReadyDownload");
    assert.ok(physicalIndex >= 0, "sanity: the physical-resolution panel must still be rendered");
    assert.ok(downloadIndex > physicalIndex, "the final download must render AFTER the print-size metadata panel, never before it");
  });

  it("SignPrintReadyDownload is the LAST rendered element in the ready-state workspace (nothing else follows it)", () => {
    const downloadIndex = source.indexOf("<SignPrintReadyDownload");
    const afterDownload = source.slice(downloadIndex + 1);
    // The only JSX tags after this point should be closing tags for the
    // component itself and its ancestor containers — no sibling
    // component/section opens after it.
    assert.doesNotMatch(
      afterDownload.replace(/<\/[a-zA-Z]+>/g, ""),
      /<[A-Z][A-Za-z]*\b/,
      "no other component may open after SignPrintReadyDownload — it owns the very bottom of the workflow",
    );
  });

  it("SignProductionAction's wrapping section is skipped once the candidate is truly print ready (no leftover empty 'Print-ready' section above the panels)", () => {
    assert.match(source, /productionCta\.kind !== "print_ready"/);
  });

  it("never renders the retired 'Download corrected artwork' copy anywhere on this page", () => {
    assert.doesNotMatch(source, /Download corrected artwork/);
  });
});
