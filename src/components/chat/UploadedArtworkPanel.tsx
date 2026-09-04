"use client";

import { useState, type ReactNode } from "react";

import {
  describeApprovedPreparation,
  describePrintReadyPreparation,
  PRINT_READY_NEEDS_ATTENTION_MESSAGE,
  UPLOAD_QUALITY_GUIDANCE_COPY,
  type ArtworkPreparationView,
} from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import {
  PRINT_READY_RETRY_ACTION_LABEL,
  PRINT_READY_RETRY_MESSAGE,
  PRINT_READY_RETRY_SUPPORTING_MESSAGE,
  PRINT_READY_WAITING_MESSAGE,
} from "@/capabilities/shared/waiting-copy";
import { OPENING_PROMPT } from "@/lib/domain/conversation";
import { PRINT_PLACEMENT_LABELS } from "@/lib/domain/print-placement";
import type { GarmentSizeClass, PrintPlacement } from "@/lib/domain/types";
import type { SignPlanCustomerView } from "@/capabilities/sign-preparation";
import type {
  CustomerFinalizationStatus,
  SignArtworkView,
} from "@/lib/services/conversation-service";
import type { ImagePoint } from "./artwork-click-mapping";
import { ArtworkComparison } from "./ArtworkComparison";
import CorrectionFinalReview from "./CorrectionFinalReview";
import CorrectionWorkspace from "./CorrectionWorkspace";
import { PREVIEW_BACKGROUND_COPY } from "./preview-background";
import { PrintReadySizeCard } from "./PrintReadySizeCard";
import { SeparationReviewPanel, type SeparationCheckStatus } from "./SeparationReviewPanel";
import {
  isRoutedToOperatorSeparationReview,
  needsAutomaticBackgroundReview,
  type UploadedArtworkStep,
} from "./uploaded-artwork-flow";

/**
 * Existing Artwork → Print Ready Phase 1: the Upload Existing Artwork
 * surface.
 *
 * This customer already HAS their design, so this panel deliberately never
 * asks for a design description, never offers three creative directions, and
 * never runs a wording interview. It asks only what production genuinely
 * needs to know — what we're printing on, its colour, and where the print
 * goes — then shows what we found and what we did.
 *
 * Every sentence it renders comes from the server
 * (`ArtworkPreparationView.customer`, authored in `preparation-copy.ts`). No
 * copy is derived here from analysis numbers, because analysis numbers never
 * reach this component in the first place.
 */

const PLACEMENT_OPTIONS = Object.entries(PRINT_PLACEMENT_LABELS) as Array<
  [PrintPlacement, string]
>;

import type { PrintReadyPackageView } from "@/capabilities/shared/production-variant";
import { describePackageGuidance } from "@/capabilities/shared/production-variant";

import { PrintReadyPackageCard } from "./PrintReadyPackageCard";

export interface UploadedArtworkPanelProps {
  step: UploadedArtworkStep;
  preparation: ArtworkPreparationView | null;
  busy: boolean;
  /**
   * Intelligent Separation Phase 10 (Goal 3): the id `SeparationReviewPanel`
   * fetches and writes its own state against. This panel never reads or
   * recomputes separation state itself — only mounts the surface that does.
   */
  projectId: string;
  /** Signed image URLs the parent resolves. `null` while loading or unavailable. */
  originalImageUrl: string | null;
  preparedImageUrl: string | null;
  /**
   * Phase 1.4: opaque identity of the prepared bytes currently shown (or last
   * successfully fetched). Workspace keys the <img> on this so a new
   * derivation cannot reuse a stale decoded bitmap.
   */
  preparedRevision?: string | null;
  onUpload: (file: File) => void;
  /**
   * LIVE PRODUCT BLOCKER #1: the routing answer at `choose_artwork_type`.
   * Client-only — see `ArtworkTypeChoice`'s doc in `uploaded-artwork-flow.ts`.
   */
  onChooseArtworkType?: (choice: "dtf" | "sign") => void;
  /** Sign path: the human-confirmed ordered width/height (Constitution §16A.2). */
  onConfirmSignSize?: (input: {
    orderedWidthIn: number;
    orderedHeightIn: number;
  }) => void;
  /**
   * LIVE PRODUCT BLOCKER #3: "Check my artwork" — runs the existing Signs
   * inspection/diagnosis/planning capability.
   */
  onPlanSignArtwork?: () => void;
  /**
   * LIVE PRODUCT BLOCKER #4: the customer's own self-service production-risk
   * authorization of the CURRENT plan — offered only when
   * `signArtwork.plan.status === "ready"` (an `auto_safe` plan; a
   * `needs_review` plan requires an operator, never a customer, to
   * authorize it — `SignPlanReviewStep` never renders this action for that
   * status). Only marks consent; the actual provider-bounded execution is a
   * SEPARATE, internal-operator-only action on
   * `/internal/projects/[projectId]/sign-authorize`. Production Workspace
   * Bridge: on success, `ChatApp.tsx` navigates the browser there — this
   * prop itself still only performs the authorization request.
   */
  onAuthorizeSignPlan?: () => void;
  /**
   * Production Workspace Bridge: "Continue to production" — navigates the
   * operator from the `sign_plan_authorized` step into the existing
   * internal production workspace (`/internal/projects/[projectId]
   * /sign-authorize`). Offered once the customer's own authorization of
   * the CURRENT plan is already durably recorded — see
   * `sign-production-bridge.ts`. Pure navigation: never itself touches a
   * pixel or calls a provider.
   */
  onContinueToProduction?: () => void;
  /** The Signs authority's own state, once a Sign artwork type is chosen. */
  signArtwork?: SignArtworkView | null;
  onSaveDetails: (input: {
    productSummary: string | null;
    productColor: string | null;
    printPlacement: PrintPlacement | null;
  }) => void;
  onPrepare: () => void;
  onApprove: () => void;
  /**
   * Intelligent Separation Phase 10 (Goal 3): fired after "Use This
   * Preparation" succeeds inside `SeparationReviewPanel`. That action
   * already updated `preparedAssetId` and project status server-side, the
   * same fields `onApprove` sets — the parent should refresh its snapshot
   * exactly as it would after any other preparation action, so the flow
   * advances to the approved step.
   */
  onSeparationApproved?: () => void;
  /** "Keep / go back" — returns to the details step without discarding anything. */
  onReconsider: () => void;
  /**
   * Existing Artwork → Print Ready Phase 2: the production size this artwork
   * will be prepared at, and the customer's control over it. `null` when
   * nothing honest can be stated yet (no print location).
   */
  printReadySize?: PrintReadySizeView | null;
  onChoosePrintWidth?: (widthIn: number) => void;
  /** Print'em All Phase 1: "Use recommended size" — the one-click confirmation. */
  onUseRecommendedSize?: () => void;
  /** Print'em All Phase 1: the garment sizing context the recommendation is derived for. */
  onChooseGarmentSize?: (garmentSizeClass: GarmentSizeClass) => void;
  /** Customer-safe finalization state. Never a job id, provider name, or internal status. */
  finalizationStatus?: CustomerFinalizationStatus;
  /** The explicit "Create Print-Ready Artwork" action. Idempotent server-side, so a double click is safe. */
  onPrepareForPrint?: () => void;
  /**
   * Phase 27M: true from the moment "Create Print-Ready Artwork" (or "Try
   * Again") is clicked until that request's own response comes back —
   * distinct from `finalizationStatus === "preparing"`, which only becomes
   * true AFTER the server has answered and the project is durably
   * `"finalizing"`. Without this, the request itself has a silent gap: the
   * button merely looks disabled for the round trip, with nothing saying a
   * click registered at all.
   */
  preparingForPrint?: boolean;
  /**
   * Print'em All Phase 3 (V1 multi-variant package): the fixed two-variant
   * print-ready package, or `undefined` for every project the server did
   * not include one for (internal-only, same as the removed production-
   * treatment surface used to be).
   */
  printReadyPackage?: PrintReadyPackageView;
  /**
   * Phase 28H: the OPTIONAL "Create DTF Halftone Version" action — offered
   * only once Standard Raster has reached a terminal state (see
   * `PrintReadyPackageCard`, which is where this actually renders). Creates
   * ONLY the Halftone variant; never re-runs, overwrites, or invalidates
   * Standard Raster.
   */
  onCreateHalftoneVersion?: () => void;
  /** True from the moment "Create DTF Halftone Version" is clicked until that request's own response returns — same reasoning as `preparingForPrint`. */
  creatingHalftoneVersion?: boolean;
  /**
   * Existing Artwork → Print Ready Phase 1.3: the customer pointed at an
   * area to PREVIEW — not yet remove. Receives SOURCE IMAGE pixels.
   */
  onCleanupPoint?: (
    point: ImagePoint,
    options: { tool: "region" | "magic_select"; tolerance: number },
  ) => void;
  /** Confirm the pending previewed removal. */
  onConfirmCleanup?: () => void;
  /** Dismiss the pending preview without mutating. */
  onCancelCleanupPreview?: () => void;
  /** Takes back the most recent guided removal. */
  onUndoCleanup?: () => void;
  /**
   * The server's already-phrased answer to the last cleanup action —
   * including refusals and the confirm prompt. Rendered verbatim.
   */
  cleanupMessage?: string | null;
  /**
   * Exact-region highlight while a removable area is pending confirmation.
   * Ephemeral — never implies the prepared bytes changed.
   */
  cleanupPreviewHighlight?: {
    bounds: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };
    overlayDataUrl: string;
  } | null;
}

export function UploadedArtworkPanel(props: UploadedArtworkPanelProps) {
  const { step, preparation, busy } = props;

  return (
    <section
      aria-label="Upload existing artwork"
      className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
    >
      {step === "upload" ? <UploadStep busy={busy} onUpload={props.onUpload} /> : null}

      {step === "choose_artwork_type" ? (
        <ArtworkTypeStep busy={busy} onChoose={props.onChooseArtworkType} />
      ) : null}

      {step === "confirm_sign_size" ? (
        <SignSizeStep
          busy={busy}
          signArtwork={props.signArtwork ?? null}
          onConfirm={props.onConfirmSignSize}
        />
      ) : null}

      {step === "sign_context_saved" ? (
        <SignContextSavedStep
          busy={busy}
          signArtwork={props.signArtwork ?? null}
          onPlan={props.onPlanSignArtwork}
        />
      ) : null}

      {step === "sign_plan_review" && props.signArtwork?.plan ? (
        <SignPlanReviewStep
          plan={props.signArtwork.plan}
          busy={busy}
          onAuthorize={props.onAuthorizeSignPlan}
        />
      ) : null}

      {step === "sign_plan_authorized" ? (
        <SignPlanAuthorizedStep
          busy={busy}
          onContinueToProduction={props.onContinueToProduction}
        />
      ) : null}

      {step === "confirm_details" && preparation ? (
        <DetailsStep
          preparation={preparation}
          busy={busy}
          onSave={props.onSaveDetails}
        />
      ) : null}

      {step === "review_analysis" && preparation ? (
        <AnalysisStep
          projectId={props.projectId}
          preparation={preparation}
          busy={busy}
          onPrepare={props.onPrepare}
          onChangeDetails={props.onReconsider}
          onSeparationApproved={props.onSeparationApproved}
        />
      ) : null}

      {step === "compare" && preparation ? (
        <CompareStep
          projectId={props.projectId}
          preparation={preparation}
          busy={busy}
          originalImageUrl={props.originalImageUrl}
          preparedImageUrl={props.preparedImageUrl}
          preparedRevision={props.preparedRevision ?? preparation.preparedRevision}
          onApprove={props.onApprove}
          onSeparationApproved={props.onSeparationApproved}
          onReconsider={props.onReconsider}
          onCleanupPoint={props.onCleanupPoint}
          onConfirmCleanup={props.onConfirmCleanup}
          onCancelCleanupPreview={props.onCancelCleanupPreview}
          onUndoCleanup={props.onUndoCleanup}
          cleanupMessage={props.cleanupMessage ?? null}
          cleanupPreviewHighlight={props.cleanupPreviewHighlight ?? null}
        />
      ) : null}

      {step === "approved" && preparation ? (
        <ApprovedStep
          preparation={preparation}
          busy={busy}
          originalImageUrl={props.originalImageUrl}
          preparedImageUrl={props.preparedImageUrl}
          printReadySize={props.printReadySize ?? null}
          onChoosePrintWidth={props.onChoosePrintWidth}
          onUseRecommendedSize={props.onUseRecommendedSize}
          onChooseGarmentSize={props.onChooseGarmentSize}
          finalizationStatus={props.finalizationStatus ?? "not_requested"}
          onPrepareForPrint={props.onPrepareForPrint}
          preparingForPrint={props.preparingForPrint ?? false}
          printReadyPackageCard={
            // Phase 28H: THE production-request authority now. Sits BEFORE
            // the single-treatment action button/banner below it — a
            // completed (or terminally-stalled) Standard Raster attempt is a
            // fact about the past, independent of whatever the operator is
            // about to try next, and the OPTIONAL "Create DTF Halftone
            // Version" affordance now lives inside this card (see
            // `PrintReadyPackageCard`) rather than behind a separate
            // pre-creation treatment CHOICE (Print'em All Phase 2's
            // `ProductionTreatmentPanel`, removed this phase — Standard
            // Raster is always attempted first, automatically, with no
            // customer decision required before it runs).
            props.printReadyPackage && props.printReadyPackage.variants.length > 0 ? (
              <PrintReadyPackageCard
                projectId={props.projectId}
                variants={props.printReadyPackage.variants}
                guidance={describePackageGuidance(props.printReadyPackage.variants)}
                onCreateHalftoneVersion={props.onCreateHalftoneVersion}
                creatingHalftoneVersion={props.creatingHalftoneVersion ?? false}
              />
            ) : null
          }
        />
      ) : null}
    </section>
  );
}

function UploadStep({
  busy,
  onUpload,
}: {
  busy: boolean;
  onUpload: (file: File) => void;
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">Upload your artwork</p>
      <p className="mt-1 text-sm text-muted">
        Choose the image you&apos;d like printed. We&apos;ll take a look and
        get it ready — we won&apos;t change your design.
      </p>
      <label className="mt-3 flex w-full cursor-pointer items-center justify-center rounded-xl border border-dashed border-black/15 px-4 py-6 text-sm text-muted transition hover:border-ink/30 hover:text-ink">
        <input
          type="file"
          accept="image/png"
          disabled={busy}
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clearing the input lets the same file be re-chosen after a
            // rejection; without it the change event never fires again.
            event.target.value = "";
            if (file) onUpload(file);
          }}
        />
        {busy ? "Uploading…" : "Choose a PNG file"}
      </label>
      <p className="mt-2 text-xs text-muted">
        We can work with PNG images right now.
      </p>
      <div className="mt-3">
        <p className="text-xs font-medium text-ink">
          {UPLOAD_QUALITY_GUIDANCE_COPY.headline}
        </p>
        <p className="mt-1 text-xs text-muted">
          {UPLOAD_QUALITY_GUIDANCE_COPY.recommendation}
        </p>
        <p className="mt-1 text-xs text-muted">
          {UPLOAD_QUALITY_GUIDANCE_COPY.limitation}
        </p>
        <p className="mt-1 text-xs text-muted">
          {UPLOAD_QUALITY_GUIDANCE_COPY.reassurance}
        </p>
        <p className="mt-1.5 text-xs text-muted">
          {UPLOAD_QUALITY_GUIDANCE_COPY.bestPractices}
        </p>
      </div>
    </div>
  );
}

/**
 * LIVE PRODUCT BLOCKER #1: the routing question, reused verbatim from the
 * Create New Artwork flow's opening line (`OPENING_PROMPT`) rather than a
 * second, independently-worded copy of the same question. Deliberately
 * asks only "DTF/Apparel" or "Sign" — never the physical substrate (rigid
 * sign, banner, coroplast, aluminum…), which belongs to physical ordering,
 * not artwork preparation, and never an internal engine name.
 */
function ArtworkTypeStep({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose?: (choice: "dtf" | "sign") => void;
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">{OPENING_PROMPT}</p>
      <p className="mt-1 text-sm text-muted">
        Just one question so we ask only what we need next.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose?.("dtf")}
          className="rounded-xl border border-black/8 p-3 text-left transition enabled:hover:border-ink/30 enabled:hover:bg-black/[0.02] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="block text-sm font-medium text-ink">DTF / Apparel</span>
          <span className="mt-1 block text-xs text-muted">
            A design that prints onto a garment — a shirt, hoodie, tote, or similar.
          </span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onChoose?.("sign")}
          className="rounded-xl border border-black/8 p-3 text-left transition enabled:hover:border-ink/30 enabled:hover:bg-black/[0.02] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="block text-sm font-medium text-ink">Sign</span>
          <span className="mt-1 block text-xs text-muted">
            Artwork for a physical sign, at a specific width and height.
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * LIVE PRODUCT BLOCKER #1: the Sign path's only production-context
 * question — the human-confirmed ordered physical size (Constitution
 * §16A.2). Deliberately never asks substrate/product type (rigid sign,
 * banner, coroplast, aluminum…) — that belongs to physical ordering, not
 * artwork preparation.
 */
function SignSizeStep({
  busy,
  signArtwork,
  onConfirm,
}: {
  busy: boolean;
  signArtwork: SignArtworkView | null;
  onConfirm?: (input: { orderedWidthIn: number; orderedHeightIn: number }) => void;
}) {
  const [widthIn, setWidthIn] = useState(
    signArtwork?.orderedWidthIn != null ? String(signArtwork.orderedWidthIn) : "",
  );
  const [heightIn, setHeightIn] = useState(
    signArtwork?.orderedHeightIn != null ? String(signArtwork.orderedHeightIn) : "",
  );

  const parsedWidth = Number(widthIn);
  const parsedHeight = Number(heightIn);
  const canContinue =
    widthIn.trim() !== "" &&
    heightIn.trim() !== "" &&
    Number.isFinite(parsedWidth) &&
    Number.isFinite(parsedHeight) &&
    parsedWidth > 0 &&
    parsedHeight > 0;

  return (
    <div>
      <p className="text-sm font-semibold text-ink">What size is this sign?</p>
      <p className="mt-1 text-sm text-muted">
        The ordered physical dimensions — we&apos;ll use these to check your
        artwork and prepare it correctly.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-ink">Width (inches)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={widthIn}
            disabled={busy}
            onChange={(event) => setWidthIn(event.target.value)}
            className="mt-1 w-full rounded-xl border border-black/10 px-3 py-2 text-sm text-ink outline-none focus:border-ink/40 disabled:opacity-50"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-ink">Height (inches)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={heightIn}
            disabled={busy}
            onChange={(event) => setHeightIn(event.target.value)}
            className="mt-1 w-full rounded-xl border border-black/10 px-3 py-2 text-sm text-ink outline-none focus:border-ink/40 disabled:opacity-50"
          />
        </label>
      </div>

      <button
        type="button"
        disabled={busy || !canContinue}
        onClick={() =>
          onConfirm?.({ orderedWidthIn: parsedWidth, orderedHeightIn: parsedHeight })
        }
        className="mt-4 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}

/**
 * LIVE PRODUCT BLOCKER #1/#3: the Sign path once the ordered size is saved,
 * before any plan exists yet. "Check my artwork" is the customer's explicit
 * request to run the existing inspection/diagnosis/planning capability —
 * deliberately never automatic, mirroring the DTF path's own explicit
 * "Remove the Background" action rather than running it silently on arrival.
 *
 * Also the step a reload lands back on after a BLOCKED planning outcome
 * (see `SignArtworkView.plan`'s doc) — re-clicking is safe and
 * deterministic, so this is never a dead end even then.
 */
function SignContextSavedStep({
  busy,
  signArtwork,
  onPlan,
}: {
  busy: boolean;
  signArtwork: SignArtworkView | null;
  onPlan?: () => void;
}) {
  const hasSize =
    signArtwork?.orderedWidthIn != null && signArtwork?.orderedHeightIn != null;
  return (
    <div>
      <p className="text-sm font-semibold text-ink">Your sign details are saved</p>
      <p className="mt-1 text-sm text-muted">
        {hasSize
          ? `${signArtwork!.orderedWidthIn}" × ${signArtwork!.orderedHeightIn}"`
          : "We've saved your sign details."}
      </p>
      <p className="mt-2 text-sm text-ink">
        Next, we&apos;ll take a look at your artwork and let you know what we find.
      </p>
      <button
        type="button"
        disabled={busy || !onPlan}
        onClick={onPlan}
        className="mt-4 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Checking…" : "Check my artwork"}
      </button>
    </div>
  );
}

/**
 * LIVE PRODUCT BLOCKER #3/#4: the customer-facing rendering of a real,
 * already-formulated Signs plan. Renders ONLY what
 * `describeSignPlanForCustomer` (`sign-preparation-copy.ts`) already
 * translated — this component makes no production decision of its own and
 * never renders a raw defect code or step kind. `plan.status` decides the
 * framing; `plan.findings` and `plan.proposedAction` are already full,
 * customer-safe sentences.
 *
 * The primary continuation action ("Prepare artwork") is offered ONLY for
 * `status === "ready"` (an `auto_safe` plan — `isAuthorizationSufficientForRisk`
 * accepts a customer's own consent for exactly this risk class,
 * `sign-plan-authorization.ts`). A `needs_review` plan shows the existing
 * "Review required" explanation and NO action — only an operator may
 * authorize it, and this component never pretends otherwise. A `blocked`
 * plan has no action to offer at all. Clicking "Prepare artwork" only
 * records consent (`onAuthorizeSignPlan` → the customer's own
 * self-service authorization route) — it does not itself touch a pixel or
 * call any provider; `uploaded-artwork-flow.ts`'s routing moves this step
 * to `sign_plan_authorized` once that consent is durably recorded, so this
 * component is never asked to render the action a second time.
 */
function SignPlanReviewStep({
  plan,
  busy,
  onAuthorize,
}: {
  plan: SignPlanCustomerView;
  busy: boolean;
  onAuthorize?: () => void;
}) {
  const headline =
    plan.status === "blocked"
      ? "This one needs a closer look"
      : "Here's what we found";

  return (
    <div>
      <p className="text-sm font-semibold text-ink">{headline}</p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs font-medium text-muted">Your artwork</p>
          <p className="text-sm text-ink">
            {plan.artworkWidthPx} × {plan.artworkHeightPx} pixels
          </p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Your sign</p>
          <p className="text-sm text-ink">
            {plan.orderedWidthIn}&quot; × {plan.orderedHeightIn}&quot;
          </p>
        </div>
      </div>

      {plan.findings.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {plan.findings.map((finding) => (
            <li key={finding} className="text-sm text-ink">
              {finding}
            </li>
          ))}
        </ul>
      ) : plan.status === "ready" ? (
        <p className="mt-3 text-sm text-ink">
          Your artwork already fits the ordered size well.
        </p>
      ) : null}

      {plan.status !== "blocked" ? (
        <div className="mt-4 rounded-xl border border-black/8 bg-black/[0.02] p-3">
          <p className="text-sm font-medium text-ink">Here&apos;s how we can prepare it</p>
          <p className="mt-1 text-sm text-ink">
            {plan.proposedAction ?? "Nothing needs to change — it's ready as-is."}
          </p>
          {plan.status === "ready" ? (
            <button
              type="button"
              disabled={busy || !onAuthorize}
              onClick={onAuthorize}
              className="mt-3 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="sign-authorize-plan-button"
            >
              {busy ? "Preparing…" : "Prepare artwork"}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-black/8 bg-black/[0.02] p-3">
          <p className="text-sm text-ink">
            We can&apos;t safely prepare this artwork automatically yet — our team
            will need to take a closer look.
          </p>
        </div>
      )}

      {/* LIVE PRODUCT BLOCKER #3A: ONE review explanation, in one place —
          previously this same idea also appeared as a translated finding
          (`repair_requires_review`), which read as the screen repeating
          itself. A `needs_review` plan's "approval" is an OPERATOR action
          (`isAuthorizationSufficientForRisk`, `sign-plan-authorization.ts`)
          — this component never offers a button here, only says why. */}
      {plan.reviewRequired ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-ink">Review required</p>
          <p className="mt-1 text-sm text-ink">
            We&apos;ll need your approval before making these changes.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * LIVE PRODUCT BLOCKER #4 / Production Workspace Bridge: the customer's own
 * part of the Signs lifecycle is done — their production-risk authorization
 * is durably recorded (`SignArtworkView.authorization.matchesCurrentPlan`).
 *
 * This step used to be a genuine dead end ("You're all set" and nothing
 * else) — accurate about authorization, but silent about what happens next,
 * for a current operating model where Eric IS both the person submitting
 * this artwork and the production operator (`AGENTS.md`'s "current user
 * model": this is deliberately not a customer-vs-staff role system yet).
 * "Continue to production" bridges directly into the existing internal
 * production workspace (`/internal/projects/[projectId]/sign-authorize`) —
 * this component still does NOT expose a "Prepare"/"Execute" control
 * itself: the actual provider-bounded reconstruction, preservation
 * verification, Fit-to-Production, and PrintValidation remain that
 * workspace's own next action, reached by navigating there rather than by
 * duplicating any of its controls here. Never claims print readiness or
 * that preparation has happened; the copy says only that the PLAN is
 * approved (see `describeApprovedPreparation`'s own equivalent discipline
 * for the DTF path).
 */
function SignPlanAuthorizedStep({
  busy,
  onContinueToProduction,
}: {
  busy: boolean;
  onContinueToProduction?: () => void;
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-ink">
        Your preparation plan is approved
      </p>
      <p className="mt-1 text-sm text-ink">
        Continue to production to prepare and review the artwork for this sign.
      </p>
      <button
        type="button"
        disabled={busy || !onContinueToProduction}
        onClick={onContinueToProduction}
        className="mt-3 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="sign-continue-to-production-button"
      >
        Continue to production
      </button>
    </div>
  );
}

function DetailsStep({
  preparation,
  busy,
  onSave,
}: {
  preparation: ArtworkPreparationView;
  busy: boolean;
  onSave: UploadedArtworkPanelProps["onSaveDetails"];
}) {
  const [productSummary, setProductSummary] = useState(
    preparation.productSummary ?? "",
  );
  const [productColor, setProductColor] = useState(preparation.productColor ?? "");
  const [placement, setPlacement] = useState<PrintPlacement | "">(
    preparation.printPlacement ?? "",
  );

  return (
    <div>
      <p className="text-sm font-semibold text-ink">
        Got it — what are we printing this on?
      </p>
      <p className="mt-1 text-sm text-muted">
        Just a couple of details so we prepare your artwork at the right size.
      </p>

      <div className="mt-3 grid gap-3">
        <label className="block">
          <span className="text-xs font-medium text-ink">What we&apos;re printing</span>
          <input
            type="text"
            value={productSummary}
            disabled={busy}
            maxLength={200}
            placeholder="e.g. T-shirts for our bowling team"
            onChange={(event) => setProductSummary(event.target.value)}
            className="mt-1 w-full rounded-xl border border-black/10 px-3 py-2 text-sm text-ink outline-none focus:border-ink/40 disabled:opacity-50"
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-ink">Garment colour</span>
          <input
            type="text"
            value={productColor}
            disabled={busy}
            maxLength={80}
            placeholder="e.g. Black"
            onChange={(event) => setProductColor(event.target.value)}
            className="mt-1 w-full rounded-xl border border-black/10 px-3 py-2 text-sm text-ink outline-none focus:border-ink/40 disabled:opacity-50"
          />
        </label>

        <fieldset>
          <legend className="text-xs font-medium text-ink">
            Where should this print?
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {PLACEMENT_OPTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                aria-pressed={placement === value}
                onClick={() => setPlacement(value)}
                className={`rounded-full px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  placement === value
                    ? "bg-ink text-white"
                    : "border border-black/10 text-muted hover:border-ink/30 hover:text-ink"
                }`}
              >
                {capitalize(label)}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <button
        type="button"
        disabled={busy || placement === ""}
        onClick={() =>
          onSave({
            productSummary: productSummary.trim() || null,
            productColor: productColor.trim() || null,
            printPlacement: placement === "" ? null : placement,
          })
        }
        className="mt-4 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Continue
      </button>
    </div>
  );
}

function AnalysisStep({
  projectId,
  preparation,
  busy,
  onPrepare,
  onChangeDetails,
  onSeparationApproved,
}: {
  projectId: string;
  preparation: ArtworkPreparationView;
  busy: boolean;
  onPrepare: () => void;
  onChangeDetails: () => void;
  onSeparationApproved?: () => void;
}) {
  const { customer } = preparation;

  // Phase 16: automatic preparation could not safely resolve this artwork's
  // background (`classification === "NEEDS_REVIEW"`, `customer.canPrepare
  // === false`) — the ONLY classification that previously dead-ended here
  // with no action at all. `getSeparationReview` never required a prepared
  // asset to exist (it reads the immutable original + the analysis that is
  // already present at this step), so the SAME self-contained
  // `SeparationReviewPanel` `CompareStep` already mounts can run here too.
  // Whether it actually shows anything stays entirely server-decided: the
  // internal-only gate on its own GET route (`isInternalProject`, checked
  // before `getSeparationReview` runs) is untouched, so a public/prospect
  // project still gets a 404 -> `view: null` -> this panel renders nothing,
  // and the existing terminal message below is the only thing that shows —
  // byte-for-byte the same experience a public customer has always had.
  const [separationState, setSeparationState] = useState<SeparationCheckStatus | null>(null);
  const needsReview = needsAutomaticBackgroundReview(preparation.classification);
  const routedToOperatorReview = isRoutedToOperatorSeparationReview(
    preparation.classification,
    separationState,
  );

  // Phase 28A: this is the scenario the doorway exists for — automatic
  // preparation could not run at all (`needsReview`), so there is no
  // "prepare" button above and, depending on `separationState`, sometimes
  // not even a review surface with content in it. Gated on `needsReview`
  // alone (not `routedToOperatorReview`) because "automatic preparation ...
  // never successfully runs at all" is explicitly in scope here, not just
  // the sub-case where a review screen happens to have something to show.
  // Reuses the SAME frozen CorrectionWorkspace/CorrectionFinalReview pair
  // `CompareStep` already opens — no new editor, no new algorithm.
  const [correctionMode, setCorrectionMode] = useState<"none" | "editing" | "review">("none");

  if (correctionMode === "editing") {
    return (
      <CorrectionWorkspace
        projectId={projectId}
        onDoneEditing={() => setCorrectionMode("review")}
        onCancel={() => setCorrectionMode("none")}
      />
    );
  }
  if (correctionMode === "review") {
    return (
      <CorrectionFinalReview
        projectId={projectId}
        onBackToEditing={() => setCorrectionMode("editing")}
        onUsed={() => {
          setCorrectionMode("none");
          onSeparationApproved?.();
        }}
      />
    );
  }

  return (
    <div>
      <p className="text-sm font-semibold text-ink">Here&apos;s what we found</p>
      {!routedToOperatorReview ? (
        <>
          <p className="mt-2 text-sm text-ink">{customer.backgroundMessage}</p>
          {customer.resolutionMessage ? (
            <p className="mt-2 text-sm text-ink">{customer.resolutionMessage}</p>
          ) : null}
        </>
      ) : null}

      {needsReview ? (
        <div className={routedToOperatorReview ? "mt-3" : "hidden"}>
          <SeparationReviewPanel
            projectId={projectId}
            garmentColor={preparation.productColor ?? "White"}
            onStateChange={setSeparationState}
            onApproved={onSeparationApproved}
          />
        </div>
      ) : null}

      {/* Phase 28A: a discoverable, non-competing fallback for exactly the
          case above — automatic couldn't safely handle this artwork, with
          or without a review surface that has anything to show. Prefer
          fixing the underlying automatic result whenever it can run at all;
          this is only ever the secondary path, never the default one
          (`AnalysisStep` only renders when automatic could not run). */}
      {needsReview ? (
        <div className="mt-3 rounded-xl border border-black/8 bg-black/[0.02] p-3">
          <p className="text-sm font-medium text-ink">Prefer to do it yourself?</p>
          <p className="mt-1 text-xs text-muted">
            You can remove the background yourself with our simple tools — select what to keep, brush away what
            shouldn&apos;t be there, and see the result before deciding.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setCorrectionMode("editing")}
            className="mt-2.5 rounded-full border border-black/10 px-3.5 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
            data-action="clean-up-manually"
          >
            Clean Up Manually
          </button>
        </div>
      ) : null}

      <div className={routedToOperatorReview ? "mt-3 flex flex-wrap items-center gap-3" : "mt-4 flex flex-wrap items-center gap-3"}>
        {!routedToOperatorReview && customer.canPrepare && customer.prepareActionLabel ? (
          <button
            type="button"
            disabled={busy}
            onClick={onPrepare}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Working…" : customer.prepareActionLabel}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={onChangeDetails}
          className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          Change these details
        </button>
      </div>
    </div>
  );
}

function CompareStep({
  projectId,
  preparation,
  busy,
  originalImageUrl,
  preparedImageUrl,
  onApprove,
  onSeparationApproved,
  onReconsider,
}: {
  projectId: string;
  preparation: ArtworkPreparationView;
  busy: boolean;
  originalImageUrl: string | null;
  preparedImageUrl: string | null;
  preparedRevision: string | null;
  onApprove: () => void;
  onSeparationApproved?: () => void;
  onReconsider: () => void;
  onCleanupPoint?: (
    point: ImagePoint,
    options: { tool: "region" | "magic_select"; tolerance: number },
  ) => void;
  onConfirmCleanup?: () => void;
  onCancelCleanupPreview?: () => void;
  onUndoCleanup?: () => void;
  cleanupMessage: string | null;
  cleanupPreviewHighlight: UploadedArtworkPanelProps["cleanupPreviewHighlight"];
}) {
  // Phase 27E/27G UX correction: "Edit Artwork" (Phase 28F; was "Remove
  // Background Manually") opens the SAME frozen correction workspace/review
  // built in Phase 27E
  // (CorrectionWorkspace / CorrectionFinalReview) — no new algorithm, no
  // new route. This state lives HERE (not inside SeparationReviewPanel)
  // specifically so the doorway is reachable regardless of whether
  // separation review itself has anything to show (see the
  // Phase 27E-UX-correction report §19 for
  // why the earlier placement inside SeparationReviewPanel's own
  // final-review branch left this unreachable whenever no consequential
  // regions existed at all).
  const [correctionMode, setCorrectionMode] = useState<"none" | "editing" | "review">("none");
  // Intelligent Separation Phase 10 (Goal 3/4): the ONE bit of separation
  // state this step needs, mirrored down from `SeparationReviewPanel` —
  // never re-fetched or recomputed here.
  //
  // Phase 28G Defect A CORRECTION: this used to start at `null` ("assume
  // not required") specifically so the approval button rendered on the
  // very first render, with no added round trip. Human acceptance on the
  // real Chili & Salsa order proved that assumption unsafe: the artwork's
  // separation check took roughly ten seconds, and for that entire window
  // this step showed its own ordinary, one-click-approvable review — the
  // customer began approving an answer the system had not actually
  // reached yet. `"checking"` is now the starting value and stays the
  // starting value: FAIL CLOSED. The approval button (and the ordinary
  // comparison above it) render only once `SeparationReviewPanel` has
  // positively reported which review path is authoritative — see
  // `separationChecking` / `separationGateActive` below, and
  // `ReviewPreparingState` for what shows meanwhile. This does add one
  // render's worth of visible waiting to EVERY upload, including the easy
  // ones — the alternative is showing an approval control before the
  // system knows whether approving it is safe, which is worse.
  const [separationState, setSeparationState] = useState<SeparationCheckStatus>("checking");
  const separationChecking = separationState === "checking";
  const separationGateActive = !separationChecking && separationState !== "review_not_required";

  if (correctionMode === "editing") {
    return (
      <CorrectionWorkspace
        projectId={projectId}
        onDoneEditing={() => setCorrectionMode("review")}
        onCancel={() => setCorrectionMode("none")}
      />
    );
  }
  if (correctionMode === "review") {
    return (
      <CorrectionFinalReview
        projectId={projectId}
        onBackToEditing={() => setCorrectionMode("editing")}
        onUsed={() => {
          setCorrectionMode("none");
          onSeparationApproved?.();
        }}
      />
    );
  }

  // Phase 28F — ONE CUSTOMER REVIEW, NOT TWO. When `SeparationReviewPanel`
  // has a genuine decision to show (a real proposal or consequential
  // regions — `separationGateActive`), IT is the large review: it already
  // has its own Original/Proposed Removal/Result comparison, its own
  // background-colour inspection, and its own decision actions. Showing
  // THIS step's own heading, comparison, and "Use This Artwork" button
  // above it asked the customer to approve essentially the same result
  // twice — human acceptance on the real Chili & Salsa order confirmed
  // this read as confusing and redundant. The fix is presentation-only:
  // when the panel below has something to decide, this step renders only
  // the Edit Artwork doorway (still reachable regardless of separation
  // state, per Phase 27H §0's invariant, restated below) and defers
  // entirely to the panel. When it does NOT (the ordinary case — most
  // artwork has no consequential regions at all), this step's own
  // comparison and approval remain exactly as they always were: ONE
  // review, no change in behavior.
  //
  // Phase 28G Defect A — a THIRD state now sits in front of both:
  // `separationChecking`. Neither the ordinary comparison/approval block
  // NOR `SeparationReviewPanel`'s own review are shown while it is true;
  // `ReviewPreparingState` occupies the review area instead, so the
  // customer is never looking at a legacy review that then gets swapped
  // out from underneath them.
  //
  // Phase 28G Defect B — the Edit Artwork doorway is repositioned to sit
  // AFTER the review area (loading state, ordinary comparison, or
  // `SeparationReviewPanel`, whichever applies) instead of above it. The
  // customer sees what was created before being offered the choice to
  // change it. Its reachability is unchanged by this move: still
  // unconditional on both `separationChecking` and `separationGateActive`,
  // per the Phase 27H §0 invariant restated at its new location below.
  return (
    <div>
      {separationChecking ? (
        <ReviewPreparingState />
      ) : !separationGateActive ? (
        <>
          <p className="text-sm font-semibold text-ink">Review your artwork</p>
          <p className="mt-1 text-sm text-muted">
            We removed the background automatically. Compare the prepared version with your original to make sure all
            parts of your design are still there and no unwanted background remains.
          </p>
          <p className="mt-1 text-sm text-muted" data-original-safety-copy>
            The artwork you uploaded is saved exactly as it was, so nothing here is permanent until you approve it.
          </p>

          <div className="mt-3">
            <ArtworkComparison
              original={{ url: originalImageUrl, loading: originalImageUrl === null }}
              prepared={{ url: preparedImageUrl, loading: preparedImageUrl === null }}
              reviewRequired={false}
            />
          </div>
        </>
      ) : null}

      {/* Intelligent Separation Phase 10 (Goal 2): sits after the
          comparison, before the approval controls it can replace. Renders
          nothing (`null`) for the vast majority of artwork that has no
          consequential regions — see `SeparationReviewPanel`'s own
          `review_not_required` short-circuit. Phase 28F: when this DOES
          render something, it is now the SOLE large review — see the
          block comment above. Phase 28G: kept MOUNTED (never unmounted)
          even while `separationChecking` is true, so its own fetch fires
          and reports back on schedule — only its OWN visible output is
          hidden meanwhile, the same established pattern `AnalysisStep`
          already uses for the identical need. This avoids ever showing
          this panel's own "Checking…" line stacked underneath
          `ReviewPreparingState`'s equivalent copy above. */}
      <div className={separationChecking ? "hidden" : "mt-3"}>
        <SeparationReviewPanel
          projectId={projectId}
          garmentColor={preparation.productColor ?? "White"}
          onStateChange={setSeparationState}
          onApproved={onSeparationApproved}
        />
      </div>

      {/* Phase 27H §0: this doorway is an independent, human-authoritative
          path -- it is available whether or not this artwork's automatic
          separation review is pending, because a deliberately completed
          manual correction (Done Editing -> Final Review -> Use This
          Artwork) now supersedes that review for the resulting artwork
          (`finalizeCorrection`; see `hasAcceptedManualOverride`). Phase 27G
          briefly hid this doorway while separation review was active, back
          when the server-side bypass this doorway could have created was
          still open; now that the authority transition is correctly gated
          at explicit manual finalization rather than at doorway
          visibility, hiding it would just re-create the exact dead end
          Phase 27H exists to remove (proven on the real INCREDI-BOWLS
          asset, which needs both). Phase 28F renamed it from "Remove
          Background Manually" to "Edit Artwork" -- the editor's toolbox
          (Wand/Fill/Brush/Eraser) is broader than background removal
          alone, and the old label undersold it. Phase 28G Defect B: moved
          here, below the review area, so the customer sees IHeartPrints'
          result before being offered the choice to change it — still
          unconditional on `separationChecking`/`separationGateActive`,
          same invariant as always, just a different position. */}
      <div className="mt-4 rounded-xl border border-black/8 bg-black/[0.02] p-3">
        <p className="text-sm font-medium text-ink">Want to make changes?</p>
        <p className="mt-1 text-xs text-muted">
          Use our simple tools to select what to keep, clean up what shouldn&apos;t be there, and see the result
          before deciding.
        </p>
        <button
          type="button"
          // Phase 28I Defect (real Chili & Sponsor DTF order): eligibility
          // must be the DURABLE server answer -- `preparation.hasPreparedArtwork`,
          // present the instant the very first snapshot loads -- never the
          // CLIENT's own signed-URL fetch for the comparison thumbnail
          // (`preparedImageUrl`, minted by a separate round trip in
          // `ChatApp.tsx` purely so the tile has something to paint).
          // `CorrectionWorkspace` takes only `projectId` and loads its own
          // canvas image independently (see `correction-image-load.ts`'s
          // own loading state) -- it has never needed `preparedImageUrl` to
          // be populated in this component first. Gating on it anyway left
          // the doorway looking permanently broken for several seconds on
          // every load of artwork complex enough to make that thumbnail
          // fetch slow (real intricate DTF art -- many separation regions
          // computing concurrently), with no loading affordance to explain
          // why. A customer should never have to take an unrelated action
          // (e.g. re-submitting the automatic review) to "unstick" it --
          // there was never anything to unstick; the gate itself was wrong.
          disabled={busy || !preparation.hasPreparedArtwork}
          onClick={() => setCorrectionMode("editing")}
          className="mt-2.5 rounded-full border border-black/10 px-3.5 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
          data-action="remove-background-manually"
        >
          Edit Artwork
        </button>
      </div>

      {preparation.customer.enhancementNeeded && preparation.customer.resolutionMessage ? (
        <p className="mt-3 text-sm text-ink" data-resolution-notice>
          Resolution enhancement needed. {preparation.customer.resolutionMessage}
        </p>
      ) : null}

      <div className="mt-4 space-y-2">
        {/* Intelligent Separation Phase 10 (Goal 4/6): once separation
            review is anything other than not-required, the panel above's
            own decision actions are the only approval action — they set
            the exact same fields this button's `onApprove` does. This copy
            specifically describes THAT button, so it is withheld rather
            than left to describe a control that would now just be refused
            server-side. Phase 28G: also withheld while `separationChecking`
            — same reasoning as the button itself below. */}
        {!separationChecking && !separationGateActive ? (
          <>
            <p className="text-sm font-medium text-ink">Looks good?</p>
            <p className="text-xs text-ink" data-approval-safety-copy>
              {PREVIEW_BACKGROUND_COPY.approvalGuidance}
            </p>
            <p className="text-xs text-muted">{PREVIEW_BACKGROUND_COPY.approvalTip}</p>
          </>
        ) : null}
        <p className="text-xs text-muted" data-original-safety-copy-near-approval>
          Your original upload is saved and unchanged.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Approval is ONLY ever this explicit button. Enlarge is view-only;
              Edit Artwork mutates only after Use This Artwork, and Done
              Editing never approves. Preview Background never approves.
              Phase 28G Defect A: also withheld while `separationChecking`
              — FAIL CLOSED, never rendered until the system has positively
              established which review path is authoritative. */}
          {!separationChecking && !separationGateActive ? (
            <button
              type="button"
              disabled={busy}
              onClick={onApprove}
              className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Use This Artwork
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={onReconsider}
            className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Keep my original for now
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Phase 28G Defect A: occupies the review area while `CompareStep` does
 * not yet know whether separation review is required. Deliberately plain
 * — a lightweight spinner, two lines of existing-tone copy, no fake
 * progress percentage, no animation beyond the spinner itself. Internal
 * vocabulary ("separation", "region map", "proposal") never appears here;
 * see Section 3 of the Phase 28G report for why.
 */
function ReviewPreparingState() {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-black/8 bg-black/[0.02] p-4"
      data-review-loading-state
      role="status"
    >
      <span
        aria-hidden="true"
        className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-black/20 border-t-ink"
      />
      <div>
        <p className="text-sm font-semibold text-ink">Preparing your artwork for review…</p>
        <p className="mt-0.5 text-xs text-muted">
          Checking the background removal and making sure your design stays intact.
        </p>
      </div>
    </div>
  );
}

function ApprovedStep({
  preparation,
  busy,
  originalImageUrl,
  preparedImageUrl,
  printReadySize,
  onChoosePrintWidth,
  onUseRecommendedSize,
  onChooseGarmentSize,
  finalizationStatus,
  onPrepareForPrint,
  preparingForPrint,
  printReadyPackageCard,
}: {
  preparation: ArtworkPreparationView;
  busy: boolean;
  originalImageUrl: string | null;
  preparedImageUrl: string | null;
  printReadySize: PrintReadySizeView | null;
  onChoosePrintWidth?: (widthIn: number) => void;
  /** Print'em All Phase 1: "Use recommended size" — the one-click confirmation. */
  onUseRecommendedSize?: () => void;
  /** Print'em All Phase 1: the garment sizing context the recommendation is derived for. */
  onChooseGarmentSize?: (garmentSizeClass: GarmentSizeClass) => void;
  finalizationStatus: CustomerFinalizationStatus;
  onPrepareForPrint?: () => void;
  /** Phase 27M: the "Create Print-Ready Artwork" request's own in-flight state — see the prop doc on `UploadedArtworkPanelProps`. */
  preparingForPrint?: boolean;
  /**
   * Print'em All Phase 3: the print-ready package (both variants' current
   * status/download, plus — Phase 28H — the optional "Create DTF Halftone
   * Version" affordance), or `null`.
   *
   * A SLOT rather than props threaded through two layers, because the card
   * it renders is already wired once in `UploadedArtworkPanel` and
   * duplicating that wiring here would be a second place for the two to
   * drift.
   */
  printReadyPackageCard?: ReactNode;
}) {
  const copy = describeApprovedPreparation(preparation.customer.enhancementNeeded);

  return (
    <div>
      <p className="text-sm font-semibold text-ink">{copy.headline}</p>
      <p className="mt-1 text-sm text-muted">{copy.summary}</p>

      <div className="mt-3">
        <ArtworkComparison
          original={{ url: originalImageUrl, loading: originalImageUrl === null }}
          prepared={{ url: preparedImageUrl, loading: preparedImageUrl === null }}
        />
      </div>

      <p className="mt-3 text-sm text-ink">{copy.nextStepMessage}</p>

      <PrintReadyStep
        enhancementNeeded={preparation.customer.enhancementNeeded}
        busy={busy}
        printReadySize={printReadySize}
        onChoosePrintWidth={onChoosePrintWidth}
        onUseRecommendedSize={onUseRecommendedSize}
        onChooseGarmentSize={onChooseGarmentSize}
        finalizationStatus={finalizationStatus}
        onPrepareForPrint={onPrepareForPrint}
        preparingForPrint={preparingForPrint}
        printReadyPackageCard={printReadyPackageCard}
      />
    </div>
  );
}

/**
 * Existing Artwork → Print Ready Phase 2 (Goal 11): the real continuation
 * affordance, and the only place production is ever requested for uploaded
 * artwork.
 *
 * Deliberately NOT the create_new surfaces: no concept cards, no "Use This
 * Design", no revision prompt, no "Show Me 3 New Concepts". This customer's
 * design was finished before they arrived, and the only decision left is how
 * large it prints.
 */
function PrintReadyStep({
  enhancementNeeded,
  busy,
  printReadySize,
  onChoosePrintWidth,
  onUseRecommendedSize,
  onChooseGarmentSize,
  finalizationStatus,
  onPrepareForPrint,
  preparingForPrint,
  printReadyPackageCard,
}: {
  enhancementNeeded: boolean;
  busy: boolean;
  printReadySize: PrintReadySizeView | null;
  onChoosePrintWidth?: (widthIn: number) => void;
  /** Print'em All Phase 1: "Use recommended size" — the one-click confirmation. */
  onUseRecommendedSize?: () => void;
  /** Print'em All Phase 1: the garment sizing context the recommendation is derived for. */
  onChooseGarmentSize?: (garmentSizeClass: GarmentSizeClass) => void;
  finalizationStatus: CustomerFinalizationStatus;
  onPrepareForPrint?: () => void;
  /** Phase 27M: the "Create Print-Ready Artwork" request's own in-flight state — see the prop doc on `UploadedArtworkPanelProps`. */
  preparingForPrint?: boolean;
  /** Print'em All Phase 3 / Phase 28H: the print-ready package slot — see `ApprovedStep`'s identical prop. */
  printReadyPackageCard?: ReactNode;
}) {
  // The ONE state that legitimately replaces the production authorities
  // rather than sitting alongside them: work is in the oven right now, and
  // both the size confirmation and the treatment are refused server-side
  // while it is (`ConversationCapability` throws "being prepared right now"
  // for either). Showing controls the server would refuse is the disagreement
  // between page and server this file exists to avoid.
  if (finalizationStatus === "preparing") {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-xl bg-black/[0.03] p-3 text-sm text-muted">
        <span className="inline-flex gap-1" aria-hidden="true">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse [animation-delay:150ms]">●</span>
          <span className="animate-pulse [animation-delay:300ms]">●</span>
        </span>
        {PRINT_READY_WAITING_MESSAGE}
      </div>
    );
  }

  // Print'em All Phase 2 — THE DEAD-END FIX.
  //
  // `retryable_failure` used to `return` here, rendering a retry notice and a
  // button and NOTHING ELSE. That silently deleted the production-size
  // authority — garment class, recommendation, contained dimensions, and the
  // confirmation control — from the one state where an operator most needs
  // them, because a failed attempt is precisely when they want to change
  // something before trying again.
  //
  // Live consequence, on a real Print'em All project: Standard Raster failed,
  // DTF Halftone correctly refused to be selectable without a confirmed size,
  // and the only remaining control was "Retry Preparation" — which would have
  // failed the same way. The operator had no route to the authority the
  // halftone required. A previous failed attempt must never remove the
  // controls needed to choose a different valid production treatment.
  //
  // So the retry notice is now a BANNER inside the normal layout instead of a
  // replacement for it. One size card, one treatment panel, one action button,
  // whose label reflects that an attempt already happened.
  const retryableFailure = finalizationStatus === "retryable_failure";
  const copy = describePrintReadyPreparation(enhancementNeeded);

  // Print'em All Phase 1 (Goal 6 / Goal 16): the upload path's copy of the
  // same gate. Internal Print'em All access bypasses the COMMERCIAL gates —
  // acquisition, email, payment — and deliberately not this one: internal
  // means commercially unrestricted, never production-unsafe, and an
  // unconfirmed size is a production-safety question.
  const sizeConfirmationPending = printReadySize
    ? !printReadySize.confirmed
    : false;

  return (
    <div className="mt-4 space-y-3 border-t border-black/8 pt-4">
      {/* What went wrong, ABOVE the controls that can change the outcome —
          and never instead of them. */}
      {retryableFailure ? (
        <div className="space-y-1">
          <p className="text-sm text-ink" role="alert">
            {PRINT_READY_RETRY_MESSAGE}
          </p>
          <p className="text-sm text-muted">{PRINT_READY_RETRY_SUPPORTING_MESSAGE}</p>
        </div>
      ) : null}

      {/* Size comes FIRST, as it does in the create_new flow: it is the last
          decision still open, and the button below acts on whatever it says. */}
      {printReadySize && onChoosePrintWidth ? (
        <PrintReadySizeCard
          size={printReadySize}
          busy={busy}
          onChooseWidth={onChoosePrintWidth}
          onUseRecommendedSize={onUseRecommendedSize}
          onChooseGarmentSize={onChooseGarmentSize}
        />
      ) : null}

      {/* Print'em All Phase 3 / Phase 28H: completed (or terminally-stalled)
          variant outputs, independent of whatever the operator is about to
          try next below. A successful DTF Halftone file stays visible and
          downloadable here even while Standard Raster needs enhancement
          (Phase 27O), and the OPTIONAL "Create DTF Halftone Version" action
          lives inside this card once Standard Raster reaches a terminal
          state — see `PrintReadyPackageCard`. There is no longer a
          pre-creation treatment CHOICE here at all: Standard Raster is
          always attempted first, automatically. */}
      {printReadyPackageCard}

      {/* Phase 28H: this generic banner is now a FALLBACK only, for the
          (currently theoretical) case where `printReadyPackageCard` itself
          is absent -- for every project that actually has one, the card's
          own per-variant status/reason is strictly more accurate than this
          project-level "needs attention" sentence, and showing both would
          be exactly the redundant/conflicting messaging Phase 28F already
          ruled out for the artwork review step. */}
      {finalizationStatus === "needs_review" && !printReadyPackageCard ? (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          role="alert"
        >
          {PRINT_READY_NEEDS_ATTENTION_MESSAGE}
        </p>
      ) : null}

      {/* print_ready is owned by FinalArtworkDeliveryCard — the size control
          above stays available (an upload customer has no other route to a
          different size), but the primary action does not compete with it. */}
      {finalizationStatus !== "print_ready" && onPrepareForPrint ? (
        <>
          {/* The "here is what happens next" copy is skipped after a failure —
              the banner above already said what happened, and repeating the
              first-run pitch underneath it reads as though nothing had. */}
          {retryableFailure ? null : (
            <>
              <p className="text-sm font-semibold text-ink">{copy.headline}</p>
              <p className="text-sm text-muted">{copy.message}</p>
              {copy.enhancementMessage ? (
                <p className="text-sm text-ink">{copy.enhancementMessage}</p>
              ) : null}
            </>
          )}
          <button
            type="button"
            // Print'em All Phase 1's gate, now reaching the retry path too: an
            // unconfirmed size cannot start production, and the server refuses
            // it anyway. Disabling is what keeps the button from promising an
            // action that is about to fail.
            disabled={busy || sizeConfirmationPending}
            aria-busy={busy}
            onClick={onPrepareForPrint}
            className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {/* Phase 27M §8: the request's OWN in-flight state, visible the
                instant the click handler runs — before the round trip
                returns and `finalizationStatus` has any chance to become
                `"preparing"`. That gap (click -> disabled-looking button ->
                eventual spinner banner) is exactly the "did my click work?"
                silence Phase 27L's human acceptance reported. */}
            {preparingForPrint ? (
              <>
                <span className="inline-flex gap-0.5" aria-hidden="true">
                  <span className="animate-pulse">●</span>
                  <span className="animate-pulse [animation-delay:150ms]">●</span>
                  <span className="animate-pulse [animation-delay:300ms]">●</span>
                </span>
                Creating Print-Ready Artwork…
              </>
            ) : retryableFailure ? (
              // An infrastructure problem — trying again with unchanged
              // inputs might genuinely help (`retryable_failure`'s own
              // documented meaning; see `production-variant.ts`).
              PRINT_READY_RETRY_ACTION_LABEL
            ) : (
              // Phase 28H: `needs_review` (Standard Raster's deterministic
              // `finalization_required`) NO LONGER shows "Try Again" here —
              // that framing implied a plain retry might fix a verdict that
              // will recompute identically on unchanged inputs (Section 7:
              // "Do NOT invite an identical retry when nothing has
              // changed"). The accurate explanation now lives on
              // `printReadyPackageCard`'s own Standard Raster tile. This
              // button still runs the exact same, still-idempotent request
              // — genuinely useful again if the customer changes the print
              // size first — just never mislabelled as a magic fix.
              copy.actionLabel
            )}
          </button>
        </>
      ) : null}
    </div>
  );
}

function capitalize(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
