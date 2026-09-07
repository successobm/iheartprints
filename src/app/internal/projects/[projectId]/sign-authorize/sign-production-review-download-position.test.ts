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

/**
 * Production Details Hierarchy Cleanup Phase: Authorization, the QR panel,
 * and the print-size metadata panel used to render as their OWN top-level
 * sections, staying visible even when "Production details" was collapsed.
 * Same source-level structural pattern as the suite above — this page has
 * no full-render harness (see that suite's own doc) — pinning the ONE
 * invariant that matters: these three sections' JSX now falls strictly
 * BETWEEN "Production details"'s own `<summary>` and its OWN closing
 * `</details>` (the first one after that summary — nothing else nests a
 * `<details>` inside it), so they expand/collapse together with it, while
 * the revised-artwork approval panel and the final Print-ready download
 * remain OUTSIDE that same boundary.
 */
describe("Sign Production Review page: Production details hierarchy", () => {
  const source = readFileSync(
    "src/app/internal/projects/[projectId]/sign-authorize/page.tsx",
    "utf8",
  );

  const productionDetailsStart = source.indexOf("Production details");
  const productionDetailsEnd = source.indexOf("</details>", productionDetailsStart);

  it("sanity: both boundary markers were actually found", () => {
    assert.ok(productionDetailsStart >= 0, "the 'Production details' summary text must exist");
    assert.ok(productionDetailsEnd > productionDetailsStart, "a closing </details> must follow it");
  });

  it("Authorization renders inside Production details", () => {
    const authorizationIndex = source.indexOf('<h3 className="text-sm font-semibold text-ink">Authorization</h3>');
    assert.ok(authorizationIndex >= 0, "sanity: the Authorization heading must exist");
    assert.ok(authorizationIndex > productionDetailsStart && authorizationIndex < productionDetailsEnd, "Authorization must render between the Production details summary and its closing </details>");
  });

  it("the QR section renders inside Production details", () => {
    const qrIndex = source.indexOf("<SignQrPreservationPanel");
    assert.ok(qrIndex >= 0, "sanity: the QR panel must still be rendered");
    assert.ok(qrIndex > productionDetailsStart && qrIndex < productionDetailsEnd, "SignQrPreservationPanel must render between the Production details summary and its closing </details>");
  });

  it("print size metadata renders inside Production details", () => {
    const physicalIndex = source.indexOf("<SignPhysicalResolutionRepairPanel");
    assert.ok(physicalIndex >= 0, "sanity: the physical-resolution panel must still be rendered");
    assert.ok(physicalIndex > productionDetailsStart && physicalIndex < productionDetailsEnd, "SignPhysicalResolutionRepairPanel must render between the Production details summary and its closing </details>");
  });

  it("Ordered output, current status, and Proposed preparation also render inside Production details (collapse together)", () => {
    for (const marker of ["Ordered output", "Current status", "Proposed preparation"]) {
      const index = source.indexOf(marker);
      assert.ok(index >= 0, `sanity: "${marker}" must exist`);
      assert.ok(index > productionDetailsStart && index < productionDetailsEnd, `"${marker}" must render inside Production details`);
    }
  });

  it("revised-artwork approval remains OUTSIDE Production details, never moved into it", () => {
    const panelIndex = source.indexOf("<SignVisualAcceptancePanel");
    assert.ok(panelIndex >= 0, "sanity: the visual-acceptance panel must still be rendered");
    assert.ok(panelIndex < productionDetailsStart, "SignVisualAcceptancePanel must render BEFORE Production details, never inside it");
  });

  it("Print-ready download remains OUTSIDE Production details, never moved into it", () => {
    const downloadIndex = source.indexOf("<SignPrintReadyDownload");
    assert.ok(downloadIndex > productionDetailsEnd, "SignPrintReadyDownload must render AFTER Production details' own closing </details>, never inside it");
  });

  it("the historical plan-risk classification is labeled as such, never presented as bare current 'Status'", () => {
    assert.match(source, /Plan risk classification/);
    assert.doesNotMatch(source, /<h3[^>]*>Status<\/h3>/, "a bare 'Status' heading must never reappear — it read as current state and was misleading");
  });
});
