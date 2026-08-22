import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, it } from "node:test";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import type {
  CustomerFinalizationStatus,
  ProductionTreatmentView,
} from "@/lib/services/conversation-service";

import { UploadedArtworkPanel } from "./UploadedArtworkPanel";

/**
 * Print'em All Phase 2 — THE LIVE DEAD-END REGRESSION.
 *
 * A real internal Print'em All project reached a state with no way forward:
 *
 *   prepared artwork approved       yes
 *   garment_size_class              null
 *   production_size_confirmed_at    null
 *   finalization.status             retryable_failure  (Standard Raster)
 *
 * The Production Treatment card correctly refused DTF Halftone — "no size has
 * been confirmed for this project" — and the ONLY other control on screen was
 * "Retry Preparation", which would have failed exactly as before. The garment
 * picker, the recommendation, the contained dimensions, and the confirmation
 * control were all absent.
 *
 * The cause was a single early `return` in `PrintReadyStep` for
 * `retryable_failure`, which rendered a retry notice INSTEAD OF the production
 * authorities rather than alongside them. Server state was complete the whole
 * time — `resolvePrintReadySize` returns a full view for any approved
 * preparation, regardless of finalization status.
 *
 * The rule this file exists to hold: **a previous failed production attempt
 * must never remove the controls needed to choose a different valid
 * production treatment.**
 */

function preparation(
  overrides: Partial<ArtworkPreparationView> = {},
): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "approved",
    originalFilename: "team artwork.png",
    classification: "usable",
    customer: {
      headline: "Your artwork is ready to review",
      summary: "We removed the background.",
      enhancementNeeded: true,
      guidance: [],
    },
    hasPreparedArtwork: true,
    approved: true,
    widthPx: 584,
    heightPx: 640,
    visibleArtworkWidthPx: 562,
    visibleArtworkHeightPx: 486,
    productSummary: "T-shirts for our bowling team",
    productColor: "Black",
    printPlacement: "full_back",
    preparedRevision: "rev-1",
    ...overrides,
  } as ArtworkPreparationView;
}

/** The LIVE state: nothing confirmed, no garment class chosen. */
function unconfirmedSize(
  overrides: Partial<PrintReadySizeView> = {},
): PrintReadySizeView {
  return {
    widthIn: 10.5,
    heightIn: 9.08,
    dpi: 300,
    placementLabel: "Full Back",
    isDefaultWidth: true,
    minWidthIn: 4,
    maxWidthIn: 14,
    widthOptions: [
      { widthIn: 9, label: '9"', isStandard: false, isSelected: false },
      { widthIn: 10.5, label: '10.5" Standard', isStandard: true, isSelected: true },
      { widthIn: 12, label: '12"', isStandard: false, isSelected: false },
    ],
    note: null,
    recommendation: {
      recommendedFor: "Adult standard · Full Back",
      boxWidthIn: 10.5,
      boxHeightIn: 10.5,
      artworkWidthIn: 10.5,
      artworkHeightIn: 9.08,
      // Nobody has stated a garment class — the recommendation is an
      // ASSUMPTION, and it is labelled as one.
      assumedGarmentSizeClass: true,
      isConfirmed: false,
    },
    confirmed: false,
    confirmedAt: null,
    blockingMessage: "Confirm the print size before preparation.",
    garmentSizeOptions: [
      { value: "youth", label: "Youth", isSelected: false },
      { value: "womens_small", label: "Women's / Smaller Garment", isSelected: false },
      { value: "adult_standard", label: "Standard Adult", isSelected: false },
      { value: "adult_plus", label: "2XL–4XL / Larger Garment", isSelected: false },
      { value: "custom", label: "Custom Size", isSelected: false },
    ],
    requiresExplicitWidth: false,
    ...overrides,
  } as PrintReadySizeView;
}

function treatmentView(
  overrides: Partial<ProductionTreatmentView> = {},
): ProductionTreatmentView {
  const garment = { label: "Black", hex: "#000000", rgb: { r: 0, g: 0, b: 0 } };
  return {
    treatment: "standard_raster",
    halftone: null,
    recommended: {
      lpi: 35,
      angleDeg: 45,
      dotShape: "round",
      midtone: 1,
      chokePx: 0,
      garment,
      algorithmVersion: "iheartprints_halftone_am_v1",
    },
    selectedAt: null,
    garment,
    offerable: false,
    offerBlockedReason:
      "The halftone screen is generated for a confirmed physical size; no size has been confirmed for this project.",
    controls: {
      lpi: { min: 25, max: 55, recommended: 35 },
      angles: [22.5, 45],
      dotShapes: ["round", "ellipse"],
      midtone: { min: 0.5, max: 2, recommended: 1 },
      chokePx: { min: 0, max: 2, recommended: 0 },
    },
    ...overrides,
  } as ProductionTreatmentView;
}

function render(options: {
  finalizationStatus?: CustomerFinalizationStatus;
  size?: PrintReadySizeView | null;
  treatment?: ProductionTreatmentView | undefined;
  busy?: boolean;
} = {}) {
  return renderToString(
    createElement(UploadedArtworkPanel, {
      step: "approved" as const,
      preparation: preparation(),
      busy: options.busy ?? false,
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: "https://signed.example/prepared.png",
      printReadySize: "size" in options ? options.size! : unconfirmedSize(),
      finalizationStatus: options.finalizationStatus ?? "not_requested",
      productionTreatment:
        "treatment" in options ? options.treatment : treatmentView(),
      treatmentPreviewUrls: {},
      onUpload: () => {},
      onSaveDetails: () => {},
      onPrepare: () => {},
      onApprove: () => {},
      onReconsider: () => {},
      onChoosePrintWidth: () => {},
      onUseRecommendedSize: () => {},
      onChooseGarmentSize: () => {},
      onPrepareForPrint: () => {},
      onSelectStandardRaster: () => {},
      onSelectHalftoneTreatment: () => {},
    }),
  );
}

/** Markup stripped — assertions about what an operator READS. */
function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether the button whose label is `label` is actually disabled.
 *
 * Deliberately NOT a `/disabled/` search over the markup. Tailwind's
 * `disabled:cursor-not-allowed` and `disabled:opacity-40` put the literal
 * string "disabled" into the CLASS attribute of every one of these buttons, so
 * the naive test passes whatever the truth is. React SSR renders the real
 * boolean attribute as `disabled=""`; that is what this looks for, scoped to
 * one button.
 */
function buttonIsDisabled(html: string, label: string): boolean {
  const compact = html.replace(/\s+/g, " ");
  const pattern = new RegExp(`<button([^>]*)>\\s*${label}\\s*</button>`);
  const match = pattern.exec(compact);
  assert.ok(match, `no <button> labelled "${label}" was rendered`);
  return / disabled=""/.test(match![1]);
}

/** Every control the size authority is made of, as an operator sees them. */
function assertSizeAuthorityVisible(html: string, context: string) {
  const text = visibleText(html);
  for (const label of [
    "Youth",
    "Women's / Smaller Garment",
    "Standard Adult",
    "2XL–4XL / Larger Garment",
    "Custom Size",
  ]) {
    assert.ok(
      text.includes(label),
      `${context}: garment class "${label}" must be selectable`,
    );
  }
  assert.match(text, /10\.5/, `${context}: the recommendation must be stated`);
  assert.match(
    text,
    /confirm/i,
    `${context}: an explicit confirmation control must exist`,
  );
}

describe("Internal Existing Artwork must never dead-end on production size", () => {
  it("A: prepared + approved + unconfirmed shows the full size authority", () => {
    assertSizeAuthorityVisible(
      render({ finalizationStatus: "not_requested" }),
      "not_requested",
    );
  });

  it("B: retryable_failure + unconfirmed STILL shows the full size authority", () => {
    // THE REGRESSION. Before the fix this rendered a retry notice and a button
    // and nothing else.
    const html = render({ finalizationStatus: "retryable_failure" });
    assertSizeAuthorityVisible(html, "retryable_failure");

    // The failure is still reported — as a banner, not as a replacement.
    assert.match(visibleText(html), /Print-ready preparation couldn/);
    assert.match(visibleText(html), /Retry Preparation/);
  });

  it("C: a reload of that same state renders identically — nothing lives in component state", () => {
    // A refresh re-renders from the server snapshot. Two independent renders
    // of the same props must therefore be byte-identical; if they were not,
    // some authority would be living in the client.
    const first = render({ finalizationStatus: "retryable_failure" });
    const second = render({ finalizationStatus: "retryable_failure" });
    assert.equal(first, second);
    assertSizeAuthorityVisible(second, "reload");
  });

  it("B: the retry action is the ONLY primary action — no duplicate prepare button", () => {
    const text = visibleText(render({ finalizationStatus: "retryable_failure" }));
    const retryCount = text.split("Retry Preparation").length - 1;
    assert.equal(retryCount, 1, "exactly one retry action");
    assert.doesNotMatch(
      text,
      /Prepare Print-Ready Artwork/,
      "the first-run action must not appear alongside a retry",
    );
  });

  it("B: exactly one garment picker is rendered — never a second size authority", () => {
    const text = visibleText(render({ finalizationStatus: "retryable_failure" }));
    assert.equal(
      text.split("2XL–4XL / Larger Garment").length - 1,
      1,
      "a duplicated picker would be a second, competing size authority",
    );
  });

  it("D: the standard-adult recommendation is stated as 10.5 x 10.5", () => {
    const text = visibleText(
      render({
        finalizationStatus: "retryable_failure",
        size: unconfirmedSize({
          garmentSizeOptions: [
            { value: "youth", label: "Youth", isSelected: false },
            {
              value: "womens_small",
              label: "Women's / Smaller Garment",
              isSelected: false,
            },
            { value: "adult_standard", label: "Standard Adult", isSelected: true },
            {
              value: "adult_plus",
              label: "2XL–4XL / Larger Garment",
              isSelected: false,
            },
            { value: "custom", label: "Custom Size", isSelected: false },
          ],
        }),
      }),
    );
    assert.match(text, /10\.5/);
    // And the artwork's own CONTAINED output dimensions, which are not the box.
    assert.match(text, /9\.08|9\.1/);
  });

  it("E: choosing a garment class does NOT confirm — the recommendation stays a recommendation", () => {
    const html = render({
      finalizationStatus: "retryable_failure",
      size: unconfirmedSize({
        garmentSizeOptions: [
          { value: "youth", label: "Youth", isSelected: false },
          {
            value: "womens_small",
            label: "Women's / Smaller Garment",
            isSelected: false,
          },
          { value: "adult_standard", label: "Standard Adult", isSelected: true },
          { value: "adult_plus", label: "2XL–4XL / Larger Garment", isSelected: false },
          { value: "custom", label: "Custom Size", isSelected: false },
        ],
      }),
    });
    // Still unconfirmed, so the treatment is still refused and the primary
    // action is still disabled. A class is a context for a SUGGESTION; consent
    // is a separate act.
    assert.match(visibleText(html), /confirm/i);
    assert.equal(buttonIsDisabled(html, "DTF Halftone"), true);
    assert.equal(buttonIsDisabled(html, "Retry Preparation"), true);
  });

  it("G: DTF Halftone is NOT selectable before confirmation, and says why", () => {
    const html = render({ finalizationStatus: "retryable_failure" });
    const text = visibleText(html);
    assert.match(text, /DTF Halftone/);
    assert.match(text, /no size has been confirmed for this project/i);

    // The disabled control is the halftone one specifically — Standard
    // Raster stays selectable, because retracting to it is always allowed.
    assert.equal(buttonIsDisabled(html, "DTF Halftone"), true);
    assert.equal(buttonIsDisabled(html, "Standard Raster"), false);
  });

  it("H: DTF Halftone becomes selectable once the size is confirmed", () => {
    const html = render({
      finalizationStatus: "retryable_failure",
      size: unconfirmedSize({
        confirmed: true,
        confirmedAt: "2026-08-21T00:00:00.000Z",
        blockingMessage: null,
      }),
      treatment: treatmentView({ offerable: true, offerBlockedReason: null }),
    });
    const text = visibleText(html);
    assert.match(text, /DTF Halftone/);
    assert.doesNotMatch(text, /no size has been confirmed/i);

    assert.equal(buttonIsDisabled(html, "DTF Halftone"), false);
  });

  it("F: confirming also re-enables the production request itself", () => {
    const html = render({
      finalizationStatus: "retryable_failure",
      size: unconfirmedSize({
        confirmed: true,
        confirmedAt: "2026-08-21T00:00:00.000Z",
        blockingMessage: null,
      }),
      treatment: treatmentView({ offerable: true, offerBlockedReason: null }),
    });
    // The retry button is present and NOT disabled — confirming the size
    // unblocks the production request itself, not just the treatment.
    assert.equal(buttonIsDisabled(html, "Retry Preparation"), false);
  });

  it("I: a custom garment class asks for an explicit width instead of suggesting one", () => {
    const text = visibleText(
      render({
        finalizationStatus: "retryable_failure",
        size: unconfirmedSize({
          // No authoritative box exists for a custom garment — the honest
          // response is to ask, never to invent a recommendation.
          recommendation: null,
          requiresExplicitWidth: true,
          garmentSizeOptions: [
            { value: "youth", label: "Youth", isSelected: false },
            {
              value: "womens_small",
              label: "Women's / Smaller Garment",
              isSelected: false,
            },
            { value: "adult_standard", label: "Standard Adult", isSelected: false },
            {
              value: "adult_plus",
              label: "2XL–4XL / Larger Garment",
              isSelected: false,
            },
            { value: "custom", label: "Custom Size", isSelected: true },
          ],
        }),
      }),
    );
    assert.match(text, /Custom Size/);
    assert.doesNotMatch(
      text,
      /Recommended for/i,
      "a custom garment must not be shown a box this product does not have",
    );
  });

  it("the ordering reads: size authority → treatment → production request", () => {
    // The operator workflow should read in the order the work happens. Before
    // the fix the treatment panel was appended AFTER the prepare action.
    const text = visibleText(render({ finalizationStatus: "not_requested" }));
    const sizeAt = text.indexOf("Standard Adult");
    const treatmentAt = text.indexOf("Production treatment");
    const actionAt = text.indexOf("Prepare Print-Ready Artwork");

    assert.ok(sizeAt >= 0 && treatmentAt >= 0 && actionAt >= 0);
    assert.ok(sizeAt < treatmentAt, "size authority must come before treatment");
    assert.ok(
      treatmentAt < actionAt,
      "treatment must come before the production request it configures",
    );
  });

  it("V: after switching to halftone, the action stops calling itself a retry", () => {
    // The failed attempt was Standard Raster. Preparing a halftone plate is a
    // different piece of work — it never re-sends the reconstruction request
    // that failed — so labelling it "Retry Preparation" would describe an
    // action that does not happen.
    const stillStandard = visibleText(
      render({ finalizationStatus: "retryable_failure" }),
    );
    assert.match(stillStandard, /Retry Preparation/);

    const nowHalftone = visibleText(
      render({
        finalizationStatus: "retryable_failure",
        size: unconfirmedSize({
          confirmed: true,
          confirmedAt: "2026-08-21T00:00:00.000Z",
          blockingMessage: null,
        }),
        treatment: treatmentView({
          treatment: "halftone_dtf",
          offerable: true,
          offerBlockedReason: null,
          halftone: {
            lpi: 35,
            angleDeg: 45,
            dotShape: "round",
            midtone: 1,
            chokePx: 0,
            garment: { label: "Black", hex: "#000000", rgb: { r: 0, g: 0, b: 0 } },
            algorithmVersion: "iheartprints_halftone_am_v1",
          },
        } as never),
      }),
    );
    assert.doesNotMatch(nowHalftone, /Retry Preparation/);
    assert.match(nowHalftone, /Prepare Print-Ready Artwork/);
    // The failure itself is still reported — the banner is informational and
    // does not disappear just because the plan changed.
    assert.match(nowHalftone, /Print-ready preparation couldn/);
  });

  it("L: choosing halftone reveals the screen controls", () => {
    const text = visibleText(
      render({
        finalizationStatus: "retryable_failure",
        size: unconfirmedSize({
          confirmed: true,
          confirmedAt: "2026-08-21T00:00:00.000Z",
          blockingMessage: null,
        }),
        treatment: treatmentView({
          treatment: "halftone_dtf",
          offerable: true,
          offerBlockedReason: null,
          halftone: {
            lpi: 35,
            angleDeg: 45,
            dotShape: "round",
            midtone: 1,
            chokePx: 0,
            garment: { label: "Black", hex: "#000000", rgb: { r: 0, g: 0, b: 0 } },
            algorithmVersion: "iheartprints_halftone_am_v1",
          },
        } as never),
      }),
    );
    for (const control of [
      "Line frequency",
      "Screen angle",
      "Dot shape",
      "Tone",
      "Edge cleanup",
      "Reset to recommended defaults",
    ]) {
      assert.ok(text.includes(control), `${control} must be offered`);
    }
  });

  it("M: a PUBLIC project renders no treatment controls at all", () => {
    // The server omits the key entirely for a non-internal project, so the
    // panel has nothing to render — and the size authority is unaffected.
    const html = render({
      finalizationStatus: "retryable_failure",
      treatment: undefined,
    });
    const text = visibleText(html);
    assert.doesNotMatch(text, /Production treatment/);
    assert.doesNotMatch(text, /DTF Halftone/);
    assertSizeAuthorityVisible(html, "public");
  });

  it("`preparing` is still the one state that replaces the controls", () => {
    // Not an oversight. Both the size confirmation and the treatment are
    // refused server-side while a plate is being made, so offering them would
    // put the page and the server into open disagreement.
    const text = visibleText(render({ finalizationStatus: "preparing" }));
    assert.doesNotMatch(text, /Standard Adult/);
    assert.doesNotMatch(text, /DTF Halftone/);
  });
});
