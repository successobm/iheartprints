import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import type { SignPlanCustomerView } from "@/capabilities/sign-preparation";
import type {
  ArtworkFidelityView,
  ArtworkReconstructionView,
  SignArtworkView,
} from "@/lib/services/conversation-service";

import { resolveSignAuthorizePageState } from "../../app/internal/projects/[projectId]/sign-authorize/sign-authorize-page-state";
import {
  ArtworkReconstructionOfferBanner,
  ArtworkReconstructionReviewStep,
  RECONSTRUCTION_PROCESSING_DETAIL,
  RECONSTRUCTION_PROCESSING_HEADLINE,
} from "./ArtworkReconstructionReviewStep";
import { UploadedArtworkPanel } from "./UploadedArtworkPanel";
import {
  deriveUploadedArtworkStep,
  type ArtworkReconstructionFlowState,
  type UploadedArtworkFlowInput,
} from "./uploaded-artwork-flow";

/**
 * Phase R5 live-acceptance repair: reconstruction review must take
 * precedence over Signs production review, and the customer must see a
 * visible, single-submit in-flight state while a rebuild is pending.
 *
 * Fixtures are SHAPED like the live durable state (Signs, planned plan that
 * needs review, completed candidate pending review, wording unverified,
 * geometry review_required) — no production ids appear here.
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

/** Signs, size confirmed, plan formulated, plan NOT yet authorized — the live REGENCY shape. */
const SIGN_PLAN_NEEDS_REVIEW: SignFlow = {
  specConfirmed: true,
  hasPlan: true,
  authorization: { matchesCurrentPlan: false },
  qrResolutions: null,
};
const SIGN_PLAN_AUTHORIZED: SignFlow = {
  ...SIGN_PLAN_NEEDS_REVIEW,
  authorization: { matchesCurrentPlan: true },
};

const PENDING_REVIEW: ArtworkReconstructionFlowState = {
  status: "completed",
  reviewStatus: "pending_review",
};

function derive(overrides: Partial<UploadedArtworkFlowInput>) {
  return deriveUploadedArtworkStep({
    artworkFidelity: { status: "confirmed" },
    fidelityStepDismissed: false,
    preparation: preparation(),
    signArtwork: null,
    artworkReconstruction: null,
    choice: "undecided",
    artworkTypeChoice: "undecided",
    atProjectStart: false,
    ...overrides,
  });
}

describe("reconstruction review takes precedence over Signs production review", () => {
  it("A/B. REGENCY-shaped: Signs + planned needs-review plan + completed pending-review candidate → review_reconstruction, NOT sign_plan_review", () => {
    const step = derive({
      signArtwork: SIGN_PLAN_NEEDS_REVIEW,
      artworkReconstruction: PENDING_REVIEW,
    });
    assert.equal(step, "review_reconstruction");
    assert.notEqual(step, "sign_plan_review");
  });

  it("a pending review also outranks sign_plan_authorized, sign_context_saved, confirm_sign_size and the QR step", () => {
    const cases: [string, SignFlow][] = [
      ["authorized plan", SIGN_PLAN_AUTHORIZED],
      ["no plan yet", { ...SIGN_PLAN_NEEDS_REVIEW, hasPlan: false }],
      ["size unconfirmed", { ...SIGN_PLAN_NEEDS_REVIEW, specConfirmed: false, hasPlan: false }],
      [
        "unresolved QR",
        {
          ...SIGN_PLAN_NEEDS_REVIEW,
          qrResolutions: [{ status: "needs_attention" }] as unknown as SignFlow["qrResolutions"],
        },
      ],
    ];
    for (const [label, signArtwork] of cases) {
      assert.equal(
        derive({ signArtwork, artworkReconstruction: PENDING_REVIEW }),
        "review_reconstruction",
        label,
      );
    }
  });

  it("every unresolved lifecycle state reaches the shared review step for Signs, exactly as for non-Signs", () => {
    const unresolved: ArtworkReconstructionFlowState[] = [
      { status: "queued", reviewStatus: null },
      { status: "running", reviewStatus: null },
      { status: "recoverable", reviewStatus: null },
      { status: "failed", reviewStatus: null },
      PENDING_REVIEW,
    ];
    for (const artworkReconstruction of unresolved) {
      assert.equal(
        derive({ signArtwork: SIGN_PLAN_NEEDS_REVIEW, artworkReconstruction }),
        "review_reconstruction",
        `signs / ${artworkReconstruction.status}`,
      );
      assert.equal(
        derive({ signArtwork: null, artworkReconstruction }),
        "review_reconstruction",
        `non-signs / ${artworkReconstruction.status}`,
      );
    }
  });

  it("C. Signs without a reconstruction keeps its existing routing", () => {
    for (const artworkReconstruction of [null, undefined]) {
      assert.equal(
        derive({ signArtwork: SIGN_PLAN_NEEDS_REVIEW, artworkReconstruction }),
        "sign_plan_review",
      );
      assert.equal(
        derive({ signArtwork: SIGN_PLAN_AUTHORIZED, artworkReconstruction }),
        "sign_plan_authorized",
      );
      assert.equal(
        derive({
          signArtwork: { ...SIGN_PLAN_NEEDS_REVIEW, hasPlan: false },
          artworkReconstruction,
        }),
        "sign_context_saved",
      );
      assert.equal(
        derive({
          signArtwork: { ...SIGN_PLAN_NEEDS_REVIEW, specConfirmed: false, hasPlan: false },
          artworkReconstruction,
        }),
        "confirm_sign_size",
      );
    }
  });

  it("D. a resolved review (approved / rejected / dismissed) resumes the Signs flow — internal production review is preserved, just no longer first", () => {
    const resolved: Partial<UploadedArtworkFlowInput>[] = [
      { artworkReconstruction: { status: "completed", reviewStatus: "approved" } },
      { artworkReconstruction: { status: "completed", reviewStatus: "rejected" } },
      { artworkReconstruction: PENDING_REVIEW, reconstructionStepDismissed: true },
    ];
    for (const resolution of resolved) {
      assert.equal(
        derive({ signArtwork: SIGN_PLAN_NEEDS_REVIEW, ...resolution }),
        "sign_plan_review",
      );
      assert.equal(
        derive({ signArtwork: SIGN_PLAN_AUTHORIZED, ...resolution }),
        "sign_plan_authorized",
      );
    }
  });

  it("E. non-Signs behavior is unchanged", () => {
    // Pending review before a print location exists → shared review step.
    assert.equal(derive({ artworkReconstruction: PENDING_REVIEW }), "review_reconstruction");
    // Resolved → the ordinary next question, as before.
    assert.equal(
      derive({ artworkReconstruction: { status: "completed", reviewStatus: "approved" } }),
      "choose_artwork_type",
    );
    assert.equal(
      derive({
        artworkReconstruction: { status: "completed", reviewStatus: "rejected" },
        artworkTypeChoice: "dtf",
      }),
      "confirm_details",
    );
    // A DTF project that already committed to a print location, or already
    // has prepared/approved artwork, is still never intercepted (R4A-R).
    assert.equal(
      derive({
        preparation: preparation({ printPlacement: "full_front" }),
        artworkReconstruction: PENDING_REVIEW,
      }),
      "review_analysis",
    );
    assert.equal(
      derive({
        preparation: preparation({ hasPreparedArtwork: true }),
        artworkReconstruction: PENDING_REVIEW,
      }),
      "compare",
    );
    assert.equal(
      derive({
        preparation: preparation({ approved: true }),
        artworkReconstruction: PENDING_REVIEW,
      }),
      "approved",
    );
    // Fidelity confirmation still comes first when it is not yet confirmed.
    assert.equal(
      derive({ artworkFidelity: null, artworkReconstruction: PENDING_REVIEW }),
      "confirm_artwork_fidelity",
    );
  });

  it("an existing pending-review job is derivable from durable state alone — no client flag needed after a reload", () => {
    // FRESH_UPLOADED_ARTWORK_UI_STATE-equivalent transient inputs: nothing
    // dismissed, no client choice — exactly what a page load after deploy
    // sees for the already-generated candidate.
    assert.equal(
      derive({
        signArtwork: SIGN_PLAN_NEEDS_REVIEW,
        artworkReconstruction: PENDING_REVIEW,
        fidelityStepDismissed: false,
        reconstructionStepDismissed: false,
        choice: "undecided",
        artworkTypeChoice: "undecided",
      }),
      "review_reconstruction",
    );
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

/** A button's own opening tag, isolated — Tailwind `disabled:` classes contain the literal word "disabled". */
function buttonTag(html: string, testId: string): string | null {
  const match = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`));
  return match ? match[0] : null;
}

const NEEDS_REVIEW_PLAN: SignPlanCustomerView = {
  status: "needs_review",
  orderedWidthIn: 48,
  orderedHeightIn: 24,
  artworkWidthPx: 1000,
  artworkHeightPx: 344,
  findings: [],
  proposedAction: "We can add space around the design.",
  reviewRequired: true,
  canProceed: false,
};

const SIGN_VIEW: SignArtworkView = {
  orderedWidthIn: 48,
  orderedHeightIn: 24,
  specConfirmed: true,
  plan: NEEDS_REVIEW_PLAN,
  authorization: { authorizedBy: null, authorizedAt: null, matchesCurrentPlan: false },
  qrResolutions: null,
};

const FIDELITY_VIEW: ArtworkFidelityView = {
  contractId: "contract-1",
  status: "confirmed",
  proposalStatus: "analyzed",
  wording: [],
  protectedMarks: [],
  confirmedWording: ["REGENCY", "ESTABLISHED PROVISIONS"],
  confirmedMarks: ["™"],
  confirmedAt: "2026-09-21T23:51:39.179Z",
};

/** Live-shaped: completed, candidate present, pending review, wording unverified, geometry review_required. */
const REGENCY_SHAPED_VIEW: ArtworkReconstructionView = {
  jobId: "job-1",
  status: "completed",
  reviewStatus: "pending_review",
  candidateAssetId: "candidate-1",
  wordingVerified: false,
  geometryStatus: "review_required",
  lastError: null,
};

function renderSignsPanel(overrides: Partial<Parameters<typeof UploadedArtworkPanel>[0]> = {}) {
  const step = derive({
    signArtwork: SIGN_PLAN_NEEDS_REVIEW,
    artworkReconstruction: REGENCY_SHAPED_VIEW,
  });
  return renderToString(
    createElement(UploadedArtworkPanel, {
      projectId: "test-project-id",
      step: step!,
      preparation: preparation(),
      busy: false,
      originalImageUrl: "https://signed.example/original.png",
      preparedImageUrl: null,
      signArtwork: SIGN_VIEW,
      artworkFidelity: FIDELITY_VIEW,
      artworkReconstruction: REGENCY_SHAPED_VIEW,
      reconstructionCandidateImageUrl: "https://signed.example/candidate.png",
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
      ...overrides,
    }),
  );
}

describe("H. the shared review UI renders in the Signs customer flow", () => {
  it("shows Original vs Rebuilt, the wording and geometry warnings, and the mark check — and never the internal production-workspace action", () => {
    const html = renderSignsPanel();
    const text = visibleText(html);

    assert.match(text, /Review your rebuilt artwork/);
    assert.match(text, /Original/);
    assert.match(text, /Rebuilt/);
    assert.match(html, /https:\/\/signed\.example\/original\.png/);
    assert.match(html, /https:\/\/signed\.example\/candidate\.png/);
    // `wording_verified=false` must remain visible to the customer.
    assert.match(text, /couldn.t confirm that all the text in your rebuilt artwork matches/);
    assert.match(text, /proportions of your rebuilt artwork/);
    // TM still requires the customer's own attestation before approval.
    assert.match(text, /I.ve checked that the ™ symbol/);
    assert.ok(buttonTag(html, "artwork-reconstruction-approve-button")?.includes('disabled=""'));
    assert.ok(buttonTag(html, "artwork-reconstruction-reject-button"));
    assert.match(text, /Use rebuilt artwork/);
    assert.match(text, /Keep my original/);

    // NOT the Signs production review.
    assert.doesNotMatch(text, /Review in production workspace/);
    assert.equal(buttonTag(html, "sign-review-in-workspace-button"), null);
    assert.doesNotMatch(text, /Here.s what we found/);
  });

  it("after the review resolves, the same panel resumes the Signs production review step", () => {
    const step = derive({
      signArtwork: SIGN_PLAN_NEEDS_REVIEW,
      artworkReconstruction: { status: "completed", reviewStatus: "rejected" },
    });
    assert.equal(step, "sign_plan_review");
    const html = renderToString(
      createElement(UploadedArtworkPanel, {
        projectId: "test-project-id",
        step: step!,
        preparation: preparation(),
        busy: false,
        originalImageUrl: null,
        preparedImageUrl: null,
        signArtwork: SIGN_VIEW,
        artworkFidelity: FIDELITY_VIEW,
        artworkReconstruction: { ...REGENCY_SHAPED_VIEW, reviewStatus: "rejected" },
        onUpload: () => undefined,
        onSaveDetails: () => undefined,
        onPrepare: () => undefined,
        onApprove: () => undefined,
        onReconsider: () => undefined,
        onReviewInProductionWorkspace: () => undefined,
      }),
    );
    assert.match(visibleText(html), /Review in production workspace/);
  });
});

describe("F/G. in-flight reconstruction feedback", () => {
  const noop = () => undefined;

  it("F. the offer banner, once submitted, becomes a visible processing state with no submit button", () => {
    const html = renderToString(
      createElement(ArtworkReconstructionOfferBanner, {
        busy: true,
        requesting: true,
        onRequest: noop,
        onDismiss: noop,
      }),
    );
    const text = visibleText(html);
    assert.equal(RECONSTRUCTION_PROCESSING_HEADLINE, "Rebuilding your artwork…");
    assert.match(text, /Rebuilding your artwork…/);
    assert.match(text, /preserving the text and details you confirmed/);
    assert.match(text, /This can take a minute or two\./);
    assert.match(text, /Please keep this page open\./);
    assert.match(html, /role="status"/);
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /animate-spin/);
    assert.ok(text.includes(RECONSTRUCTION_PROCESSING_DETAIL));
    // G. no second submit / dismiss control is offered while pending.
    assert.equal(buttonTag(html, "artwork-reconstruction-request-button"), null);
    assert.equal(buttonTag(html, "artwork-reconstruction-dismiss-button"), null);
  });

  it("G. before submission the banner still offers 'Rebuild my artwork', disabled while the page is busy", () => {
    const idle = renderToString(
      createElement(ArtworkReconstructionOfferBanner, { onRequest: noop, onDismiss: noop }),
    );
    assert.match(visibleText(idle), /Rebuild my artwork/);
    assert.doesNotMatch(buttonTag(idle, "artwork-reconstruction-request-button")!, /disabled=""/);

    const busy = renderToString(
      createElement(ArtworkReconstructionOfferBanner, {
        busy: true,
        onRequest: noop,
        onDismiss: noop,
      }),
    );
    assert.match(buttonTag(busy, "artwork-reconstruction-request-button")!, /disabled=""/);
  });

  it("'Try again' after a failure also shows the processing state while pending, not the stale failure", () => {
    const failed: ArtworkReconstructionView = {
      ...REGENCY_SHAPED_VIEW,
      status: "failed",
      reviewStatus: null,
      candidateAssetId: null,
      wordingVerified: null,
      geometryStatus: null,
      lastError: "x",
    };
    const idle = renderToString(
      createElement(ArtworkReconstructionReviewStep, {
        artworkReconstruction: failed,
        confirmedMarks: null,
        originalImageUrl: null,
        candidateImageUrl: null,
        onApprove: noop,
        onReject: noop,
        onRetry: noop,
        onDismiss: noop,
      }),
    );
    assert.match(visibleText(idle), /couldn.t rebuild your artwork/);
    assert.ok(buttonTag(idle, "artwork-reconstruction-retry-button"));

    const pending = renderToString(
      createElement(ArtworkReconstructionReviewStep, {
        artworkReconstruction: failed,
        confirmedMarks: null,
        originalImageUrl: null,
        candidateImageUrl: null,
        busy: true,
        requesting: true,
        onApprove: noop,
        onReject: noop,
        onRetry: noop,
        onDismiss: noop,
      }),
    );
    assert.match(visibleText(pending), /Rebuilding your artwork…/);
    assert.equal(buttonTag(pending, "artwork-reconstruction-retry-button"), null);
    assert.doesNotMatch(visibleText(pending), /couldn.t rebuild your artwork/);
  });

  it("a job found in progress after a reload shows the same processing state, with the existing way to continue without it", () => {
    const html = renderToString(
      createElement(ArtworkReconstructionReviewStep, {
        artworkReconstruction: { ...REGENCY_SHAPED_VIEW, status: "running", reviewStatus: null },
        confirmedMarks: null,
        originalImageUrl: null,
        candidateImageUrl: null,
        onApprove: noop,
        onReject: noop,
        onRetry: noop,
        onDismiss: noop,
      }),
    );
    assert.match(visibleText(html), /Rebuilding your artwork…/);
    assert.ok(buttonTag(html, "artwork-reconstruction-dismiss-button"));
  });

  it("customer-facing processing copy exposes no implementation vocabulary and no fake progress", () => {
    const html = renderToString(
      createElement(ArtworkReconstructionOfferBanner, {
        requesting: true,
        onRequest: noop,
        onDismiss: noop,
      }),
    );
    const text = visibleText(html);
    assert.doesNotMatch(text, /openai|sunburst|provider|api|worker|\bjob\b|model|queue/i);
    assert.doesNotMatch(text, /\d+\s*%|remaining|step \d|\bof \d/i);
    assert.doesNotMatch(html, /role="progressbar"/);
  });
});

describe("I. the internal Signs authorization gate is unchanged", () => {
  it("a browser without an internal session is still refused, and an internal one still proceeds", () => {
    assert.deepEqual(
      resolveSignAuthorizePageState({ configured: true, isInternal: false, review: null }),
      { kind: "not_internal" },
    );
    assert.deepEqual(
      resolveSignAuthorizePageState({ configured: false, isInternal: true, review: null }),
      { kind: "unconfigured" },
    );
    assert.equal(
      resolveSignAuthorizePageState({
        configured: true,
        isInternal: true,
        review: { status: "no_plan" },
      }).kind,
      "no_plan",
    );
  });
});
