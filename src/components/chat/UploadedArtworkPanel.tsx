"use client";

import { useState, type ReactNode } from "react";

import {
  describeApprovedPreparation,
  describePrintReadyPreparation,
  GUIDED_CLEANUP_COPY,
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
import { PRINT_PLACEMENT_LABELS } from "@/lib/domain/print-placement";
import type { GarmentSizeClass, PrintPlacement } from "@/lib/domain/types";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";
import type { ImagePoint } from "./artwork-click-mapping";
import { ArtworkComparison } from "./ArtworkComparison";
import { GuidedCleanupWorkspace } from "./GuidedCleanupWorkspace";
import { PREVIEW_BACKGROUND_COPY } from "./preview-background";
import { PrintReadySizeCard } from "./PrintReadySizeCard";
import type { UploadedArtworkStep } from "./uploaded-artwork-flow";

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

import type { ProductionTreatmentView } from "@/lib/services/conversation-service";

import {
  ProductionTreatmentPanel,
  type TreatmentPreviewMode,
} from "./ProductionTreatmentPanel";

export interface UploadedArtworkPanelProps {
  step: UploadedArtworkStep;
  preparation: ArtworkPreparationView | null;
  busy: boolean;
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
  onSaveDetails: (input: {
    productSummary: string | null;
    productColor: string | null;
    printPlacement: PrintPlacement | null;
  }) => void;
  onPrepare: () => void;
  onApprove: () => void;
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
  /** The explicit "Prepare Print-Ready Artwork" action. Idempotent server-side, so a double click is safe. */
  onPrepareForPrint?: () => void;
  /**
   * Print'em All Phase 2: the INTERNAL operator's production-treatment
   * surface, or `undefined` for every other project.
   *
   * Undefined rather than a boolean flag, and that is the point: the panel
   * exists only when the SERVER included it, so there is no client-side
   * condition here that could be flipped to reveal it. See
   * `ProductionTreatmentPanel` — visibility is presentation, the gate is on
   * the write.
   */
  productionTreatment?: ProductionTreatmentView;
  treatmentPreviewUrls?: Partial<Record<TreatmentPreviewMode, string | null>>;
  onSelectStandardRaster?: () => void;
  onSelectHalftoneTreatment?: (settings: {
    lpi: number;
    angleDeg: number;
    dotShape: string;
    midtone: number;
    chokePx: number;
  }) => void;
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

      {step === "confirm_details" && preparation ? (
        <DetailsStep
          preparation={preparation}
          busy={busy}
          onSave={props.onSaveDetails}
        />
      ) : null}

      {step === "review_analysis" && preparation ? (
        <AnalysisStep
          preparation={preparation}
          busy={busy}
          onPrepare={props.onPrepare}
          onChangeDetails={props.onReconsider}
        />
      ) : null}

      {step === "compare" && preparation ? (
        <CompareStep
          preparation={preparation}
          busy={busy}
          originalImageUrl={props.originalImageUrl}
          preparedImageUrl={props.preparedImageUrl}
          preparedRevision={props.preparedRevision ?? preparation.preparedRevision}
          onApprove={props.onApprove}
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
          preparesDifferentTreatment={
            props.productionTreatment?.treatment === "halftone_dtf"
          }
          treatmentControls={
            // Print'em All Phase 2: rendered INSIDE the approved step rather
            // than appended after it, so it lands between the size
            // confirmation it depends on and the production request it
            // configures. Appended, it sat below "Prepare Print-Ready
            // Artwork" — reading as an afterthought to an action it is
            // supposed to precede.
            props.productionTreatment &&
            props.onSelectStandardRaster &&
            props.onSelectHalftoneTreatment ? (
              <ProductionTreatmentPanel
                view={props.productionTreatment}
                busy={busy}
                previewUrls={props.treatmentPreviewUrls ?? {}}
                onSelectStandardRaster={props.onSelectStandardRaster}
                onSelectHalftone={props.onSelectHalftoneTreatment}
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
  preparation,
  busy,
  onPrepare,
  onChangeDetails,
}: {
  preparation: ArtworkPreparationView;
  busy: boolean;
  onPrepare: () => void;
  onChangeDetails: () => void;
}) {
  const { customer } = preparation;

  return (
    <div>
      <p className="text-sm font-semibold text-ink">Here&apos;s what we found</p>
      <p className="mt-2 text-sm text-ink">{customer.backgroundMessage}</p>
      {customer.resolutionMessage ? (
        <p className="mt-2 text-sm text-ink">{customer.resolutionMessage}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {customer.canPrepare && customer.prepareActionLabel ? (
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
  preparation,
  busy,
  originalImageUrl,
  preparedImageUrl,
  preparedRevision,
  onApprove,
  onReconsider,
  onCleanupPoint,
  onConfirmCleanup,
  onCancelCleanupPreview,
  onUndoCleanup,
  cleanupMessage,
  cleanupPreviewHighlight,
}: {
  preparation: ArtworkPreparationView;
  busy: boolean;
  originalImageUrl: string | null;
  preparedImageUrl: string | null;
  preparedRevision: string | null;
  onApprove: () => void;
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
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const cleanup = preparation.guidedCleanup;
  const cleanupOffered =
    cleanup.available &&
    Boolean(onCleanupPoint) &&
    Boolean(preparedImageUrl);
  const pendingConfirmation = Boolean(cleanupPreviewHighlight);

  function closeWorkspace() {
    onCancelCleanupPreview?.();
    setWorkspaceOpen(false);
  }

  return (
    <div>
      <p className="text-sm font-semibold text-ink">
        Here&apos;s your artwork, prepared
      </p>
      <p className="mt-1 text-sm text-muted">
        Compare them side by side. Nothing about your design was changed — only
        the background around it.
      </p>

      <div className="mt-3">
        <ArtworkComparison
          original={{ url: originalImageUrl, loading: originalImageUrl === null }}
          prepared={{ url: preparedImageUrl, loading: preparedImageUrl === null }}
        />
      </div>

      {cleanupOffered ? (
        <div className="mt-3 rounded-xl border border-black/8 bg-black/[0.02] p-3">
          <p className="text-sm text-ink">{GUIDED_CLEANUP_COPY.invitation}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || !preparedImageUrl}
              onClick={() => setWorkspaceOpen(true)}
              className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {GUIDED_CLEANUP_COPY.enterActionLabel}
            </button>
            {cleanup.removalCount > 0 && onUndoCleanup ? (
              <button
                type="button"
                disabled={busy || workspaceOpen}
                onClick={onUndoCleanup}
                className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                {GUIDED_CLEANUP_COPY.undoActionLabel}
              </button>
            ) : null}
          </div>
          {cleanupMessage && !workspaceOpen ? (
            <p className="mt-2 text-xs text-ink" role="status">
              {cleanupMessage}
            </p>
          ) : null}
        </div>
      ) : null}

      {workspaceOpen && preparedImageUrl && onCleanupPoint ? (
        <GuidedCleanupWorkspace
          preparedImageUrl={preparedImageUrl}
          preparedRevision={
            preparedRevision ?? preparation.preparedRevision ?? "prepared"
          }
          sourceWidthPx={preparation.widthPx}
          sourceHeightPx={preparation.heightPx}
          busy={busy}
          removalCount={cleanup.removalCount}
          cleanupMessage={cleanupMessage}
          pendingHighlight={cleanupPreviewHighlight ?? null}
          onSelectPoint={onCleanupPoint}
          onConfirm={() => onConfirmCleanup?.()}
          onCancelPreview={() => onCancelCleanupPreview?.()}
          onUndo={() => onUndoCleanup?.()}
          onDone={closeWorkspace}
        />
      ) : null}

      {preparation.customer.enhancementNeeded &&
      preparation.customer.resolutionMessage ? (
        <p className="mt-3 text-sm text-ink">
          {preparation.customer.resolutionMessage}
        </p>
      ) : null}

      <div className="mt-4 space-y-2">
        <p className="text-xs text-ink" data-approval-safety-copy>
          {PREVIEW_BACKGROUND_COPY.approvalGuidance}
        </p>
        <p className="text-xs text-muted">{PREVIEW_BACKGROUND_COPY.approvalTip}</p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Approval is ONLY ever this explicit button. Enlarge is view-only;
              Clean Up Background mutates only after confirm, and Done never
              approves. Preview Background never approves. */}
          <button
            type="button"
            disabled={busy || pendingConfirmation || workspaceOpen}
            onClick={onApprove}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Use Prepared Artwork
          </button>
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
  treatmentControls,
  preparesDifferentTreatment,
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
  preparesDifferentTreatment?: boolean;
  /**
   * Print'em All Phase 2: the internal operator's production-treatment
   * controls, or `null`.
   *
   * A SLOT rather than props threaded through two layers, because the panel it
   * renders is already wired once in `UploadedArtworkPanel` and duplicating
   * that wiring here would be a second place for the two to drift. What this
   * slot decides is only WHERE the controls sit — which matters, because a
   * treatment is chosen after a size is confirmed and before production is
   * requested, and the ordering on screen should say so.
   */
  treatmentControls?: ReactNode;
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
        treatmentControls={treatmentControls}
        preparesDifferentTreatment={preparesDifferentTreatment}
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
  treatmentControls,
  preparesDifferentTreatment,
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
  treatmentControls?: ReactNode;
  /**
   * Print'em All Phase 2: true when the production treatment now differs from
   * the continuous-tone attempt that failed, so the action about to run is a
   * genuinely different piece of work rather than a repeat of the failed one.
   */
  preparesDifferentTreatment?: boolean;
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

      {/* Then the treatment, which is a decision ABOUT the confirmed size and
          is only selectable once there is one. Between the size and the
          action, so the screen reads in the order the work happens. */}
      {treatmentControls}

      {finalizationStatus === "needs_review" ? (
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
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {/* Print'em All Phase 2 (Goal 11): after a failed Standard Raster
                attempt, choosing DTF Halftone makes the next action a
                different piece of work — it prepares a screened plate and
                never re-sends the failed reconstruction request. Calling that
                "Retry Preparation" would describe an action that does not
                happen. */}
            {retryableFailure && preparesDifferentTreatment
              ? copy.actionLabel
              : retryableFailure
                ? PRINT_READY_RETRY_ACTION_LABEL
                : finalizationStatus === "needs_review"
                  ? "Try Again"
                  : copy.actionLabel}
          </button>
        </>
      ) : null}
    </div>
  );
}

function capitalize(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
