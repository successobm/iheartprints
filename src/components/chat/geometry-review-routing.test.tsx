import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";

import {
  GeometryConfirmationStep,
  GEOMETRY_CONFIRMATION_DETAIL,
  GEOMETRY_CONFIRMATION_HEADLINE,
} from "./GeometryConfirmationStep";
import { UploadedArtworkPanel } from "./UploadedArtworkPanel";
import {
  deriveUploadedArtworkStep,
  type ArtworkReconstructionFlowState,
  type GeometryReviewFlowState,
  type UploadedArtworkFlowInput,
} from "./uploaded-artwork-flow";

/**
 * Phase R6A (Geometry-Qualified Clean Master v1): geometry review must take
 * precedence over Signs production review and the DTF/Signs continuation,
 * but only AFTER reconstruction review has resolved — mirrors
 * `reconstruction-review-routing.test.tsx`'s own fixture/assertion style
 * exactly.
 */

function preparation(overrides: Partial<ArtworkPreparationView> = {}): ArtworkPreparationView {
  return {
    preparationId: "prep-1",
    status: "analyzed",
    originalFilename: "logo.png",
    classification: "REPAIRABLE_AUTOMATICALLY",
    customer: {
      backgroundMessage: "Your artwork has a solid background that can be removed automatically.",
      resolutionMessage: null,
      canPrepare: true,
      prepareActionLabel: "Remove the Background",
      enhancementNeeded: false,
    },
    hasPreparedArtwork: false,
    preparedReview: null,
    preparedRevision: null,
    approved: false,
    widthPx: 1000,
    heightPx: 344,
    visibleArtworkWidthPx: 1000,
    visibleArtworkHeightPx: 344,
    productSummary: null,
    productColor: null,
    printPlacement: null,
    guidedCleanup: { available: false, removalCount: 0 },
    ...overrides,
  };
}

type SignFlow = NonNullable<UploadedArtworkFlowInput["signArtwork"]>;

const SIGN_PLAN_NEEDS_REVIEW: SignFlow = {
  specConfirmed: true,
  hasPlan: true,
  authorization: { matchesCurrentPlan: false },
  qrResolutions: null,
};

const APPROVED_RECONSTRUCTION: ArtworkReconstructionFlowState = {
  status: "completed",
  reviewStatus: "approved",
};
const PENDING_RECONSTRUCTION: ArtworkReconstructionFlowState = {
  status: "completed",
  reviewStatus: "pending_review",
};

const PENDING_GEOMETRY: GeometryReviewFlowState = { status: "normalized_pending_confirmation" };
const CONFIRMED_GEOMETRY: GeometryReviewFlowState = { status: "confirmed" };
const REJECTED_GEOMETRY: GeometryReviewFlowState = { status: "rejected" };
const UNUSABLE_GEOMETRY: GeometryReviewFlowState = { status: "unusable" };

function derive(overrides: Partial<UploadedArtworkFlowInput>) {
  return deriveUploadedArtworkStep({
    artworkFidelity: { status: "confirmed" },
    fidelityStepDismissed: false,
    preparation: preparation(),
    signArtwork: null,
    artworkReconstruction: APPROVED_RECONSTRUCTION,
    geometryReview: null,
    choice: "undecided",
    artworkTypeChoice: "undecided",
    atProjectStart: false,
    ...overrides,
  });
}

describe("geometry review routing", () => {
  it("a pending geometry qualification takes over BEFORE choose_artwork_type/confirm_details (non-Signs)", () => {
    assert.equal(derive({ geometryReview: PENDING_GEOMETRY }), "review_geometry");
    assert.equal(
      derive({ geometryReview: PENDING_GEOMETRY, artworkTypeChoice: "dtf" }),
      "review_geometry",
    );
  });

  it("a pending geometry qualification takes over BEFORE every Signs production step", () => {
    const cases: [string, SignFlow][] = [
      ["needs-review plan", SIGN_PLAN_NEEDS_REVIEW],
      ["authorized plan", { ...SIGN_PLAN_NEEDS_REVIEW, authorization: { matchesCurrentPlan: true } }],
      ["no plan yet", { ...SIGN_PLAN_NEEDS_REVIEW, hasPlan: false }],
      ["size unconfirmed", { ...SIGN_PLAN_NEEDS_REVIEW, specConfirmed: false, hasPlan: false }],
    ];
    for (const [label, signArtwork] of cases) {
      assert.equal(
        derive({ signArtwork, geometryReview: PENDING_GEOMETRY }),
        "review_geometry",
        label,
      );
    }
  });

  it("reconstruction review still takes precedence over geometry review — the two are never collapsed into one question", () => {
    assert.equal(
      derive({ artworkReconstruction: PENDING_RECONSTRUCTION, geometryReview: PENDING_GEOMETRY }),
      "review_reconstruction",
    );
    assert.equal(
      derive({
        signArtwork: SIGN_PLAN_NEEDS_REVIEW,
        artworkReconstruction: PENDING_RECONSTRUCTION,
        geometryReview: PENDING_GEOMETRY,
      }),
      "review_reconstruction",
    );
  });

  it("confirmed geometry resumes the ordinary flow — never re-shown", () => {
    assert.equal(derive({ geometryReview: CONFIRMED_GEOMETRY }), "choose_artwork_type");
    assert.equal(
      derive({ signArtwork: SIGN_PLAN_NEEDS_REVIEW, geometryReview: CONFIRMED_GEOMETRY }),
      "sign_plan_review",
    );
  });

  it("rejected geometry is a safe stopped state — flow resumes, never re-offered as a step", () => {
    assert.equal(derive({ geometryReview: REJECTED_GEOMETRY }), "choose_artwork_type");
  });

  it("'unusable' geometry (deterministic qualification abstained) is a safe stopped state — flow resumes, nothing to confirm", () => {
    assert.equal(derive({ geometryReview: UNUSABLE_GEOMETRY }), "choose_artwork_type");
  });

  it("no qualification computed yet behaves exactly like today (no geometryReview field at all)", () => {
    assert.equal(derive({ geometryReview: null }), "choose_artwork_type");
    assert.equal(derive({}), "choose_artwork_type");
  });
});

// -- rendering ---------------------------------------------------------------

function visibleText(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buttonTag(html: string, testId: string): string | null {
  const match = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`));
  return match ? match[0] : null;
}

describe("GeometryConfirmationStep rendering", () => {
  const noop = () => undefined;

  it("shows the headline, body, image, and both actions", () => {
    const html = renderToString(
      createElement(GeometryConfirmationStep, {
        candidateImageUrl: "https://signed.example/derivative.png",
        onConfirm: noop,
        onReject: noop,
      }),
    );
    const text = visibleText(html);
    assert.match(text, new RegExp(GEOMETRY_CONFIRMATION_HEADLINE));
    assert.ok(text.includes(GEOMETRY_CONFIRMATION_DETAIL));
    assert.match(html, /https:\/\/signed\.example\/derivative\.png/);
    assert.match(text, /Looks good — continue/);
    assert.match(text, /Something is missing/);
  });

  it("exposes no internal/implementation vocabulary", () => {
    const html = renderToString(
      createElement(GeometryConfirmationStep, {
        candidateImageUrl: "https://signed.example/derivative.png",
        onConfirm: noop,
        onReject: noop,
      }),
    );
    const text = visibleText(html);
    assert.doesNotMatch(
      text,
      /geometry|qualification|classifier|alpha|candidate|asset|provider|sunburst|segmentation|content bounds|worker|workspace/i,
    );
  });

  it("shows 'Loading…' rather than a broken image while the URL has not resolved yet", () => {
    const html = renderToString(
      createElement(GeometryConfirmationStep, {
        candidateImageUrl: null,
        onConfirm: noop,
        onReject: noop,
      }),
    );
    assert.match(visibleText(html), /Loading…/);
  });

  it("shows a processing state while the derivative is still being computed, with no actionable buttons", () => {
    const html = renderToString(
      createElement(GeometryConfirmationStep, {
        candidateImageUrl: null,
        preparing: true,
        onConfirm: noop,
        onReject: noop,
      }),
    );
    assert.match(visibleText(html), /Preparing your artwork…/);
    assert.equal(buttonTag(html, "geometry-confirmation-confirm-button"), null);
    assert.equal(buttonTag(html, "geometry-confirmation-reject-button"), null);
  });

  it("disables both actions while busy", () => {
    const html = renderToString(
      createElement(GeometryConfirmationStep, {
        candidateImageUrl: "https://signed.example/derivative.png",
        busy: true,
        onConfirm: noop,
        onReject: noop,
      }),
    );
    assert.match(buttonTag(html, "geometry-confirmation-confirm-button")!, /disabled=""/);
    assert.match(buttonTag(html, "geometry-confirmation-reject-button")!, /disabled=""/);
  });
});

describe("UploadedArtworkPanel renders review_geometry", () => {
  it("mounts GeometryConfirmationStep at the review_geometry step, wired to the parent's handlers/image", () => {
    const step = derive({ geometryReview: PENDING_GEOMETRY });
    assert.equal(step, "review_geometry");

    const html = renderToString(
      createElement(UploadedArtworkPanel, {
        projectId: "test-project-id",
        step: step!,
        preparation: preparation(),
        busy: false,
        originalImageUrl: null,
        preparedImageUrl: null,
        geometryQualification: { qualificationId: "q-1", reconstructionJobId: "job-1", status: "normalized_pending_confirmation" },
        geometryConfirmationImageUrl: "https://signed.example/derivative.png",
        onUpload: () => {
          throw new Error("must never fire from rendering");
        },
        onSaveDetails: () => {
          throw new Error("must never fire from rendering");
        },
        onPrepare: () => {
          throw new Error("must never fire from rendering");
        },
        onApprove: () => {
          throw new Error("must never fire from rendering");
        },
        onReconsider: () => {
          throw new Error("must never fire from rendering");
        },
      } as unknown as Parameters<typeof UploadedArtworkPanel>[0]),
    );

    const text = visibleText(html);
    assert.match(text, new RegExp(GEOMETRY_CONFIRMATION_HEADLINE));
    assert.match(html, /https:\/\/signed\.example\/derivative\.png/);
    assert.ok(buttonTag(html, "geometry-confirmation-confirm-button"));
    assert.ok(buttonTag(html, "geometry-confirmation-reject-button"));
  });
});
