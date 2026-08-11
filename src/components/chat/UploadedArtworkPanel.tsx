"use client";

import { useState } from "react";

import {
  describeApprovedPreparation,
  describePrintReadyPreparation,
  GUIDED_CLEANUP_COPY,
  PRINT_READY_NEEDS_ATTENTION_MESSAGE,
  type ArtworkPreparationView,
} from "@/capabilities/artwork-preparation";
import type { PrintReadySizeView } from "@/capabilities/shared/print-ready-size";
import { PRINT_READY_WAITING_MESSAGE } from "@/capabilities/shared/waiting-copy";
import { PRINT_PLACEMENT_LABELS } from "@/lib/domain/print-placement";
import type { PrintPlacement } from "@/lib/domain/types";
import type { CustomerFinalizationStatus } from "@/lib/services/conversation-service";
import type { ImagePoint } from "./artwork-click-mapping";
import { ArtworkComparison } from "./ArtworkComparison";
import { GuidedCleanupWorkspace } from "./GuidedCleanupWorkspace";
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
  /** Customer-safe finalization state. Never a job id, provider name, or internal status. */
  finalizationStatus?: CustomerFinalizationStatus;
  /** The explicit "Prepare Print-Ready Artwork" action. Idempotent server-side, so a double click is safe. */
  onPrepareForPrint?: () => void;
  /**
   * Existing Artwork → Print Ready Phase 1.3: the customer pointed at an
   * area to PREVIEW — not yet remove. Receives SOURCE IMAGE pixels.
   */
  onCleanupPoint?: (point: ImagePoint) => void;
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
          finalizationStatus={props.finalizationStatus ?? "not_requested"}
          onPrepareForPrint={props.onPrepareForPrint}
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
  onCleanupPoint?: (point: ImagePoint) => void;
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

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Approval is ONLY ever this explicit button. Enlarge is view-only;
            Clean Up Background mutates only after confirm, and Done never
            approves. */}
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
  );
}

function ApprovedStep({
  preparation,
  busy,
  originalImageUrl,
  preparedImageUrl,
  printReadySize,
  onChoosePrintWidth,
  finalizationStatus,
  onPrepareForPrint,
}: {
  preparation: ArtworkPreparationView;
  busy: boolean;
  originalImageUrl: string | null;
  preparedImageUrl: string | null;
  printReadySize: PrintReadySizeView | null;
  onChoosePrintWidth?: (widthIn: number) => void;
  finalizationStatus: CustomerFinalizationStatus;
  onPrepareForPrint?: () => void;
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
        finalizationStatus={finalizationStatus}
        onPrepareForPrint={onPrepareForPrint}
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
  finalizationStatus,
  onPrepareForPrint,
}: {
  enhancementNeeded: boolean;
  busy: boolean;
  printReadySize: PrintReadySizeView | null;
  onChoosePrintWidth?: (widthIn: number) => void;
  finalizationStatus: CustomerFinalizationStatus;
  onPrepareForPrint?: () => void;
}) {
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

  const copy = describePrintReadyPreparation(enhancementNeeded);

  return (
    <div className="mt-4 space-y-3 border-t border-black/8 pt-4">
      {/* Size comes FIRST, as it does in the create_new flow: it is the last
          decision still open, and the button below acts on whatever it says. */}
      {printReadySize && onChoosePrintWidth ? (
        <PrintReadySizeCard
          size={printReadySize}
          busy={busy}
          onChooseWidth={onChoosePrintWidth}
        />
      ) : null}

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
          <p className="text-sm font-semibold text-ink">{copy.headline}</p>
          <p className="text-sm text-muted">{copy.message}</p>
          {copy.enhancementMessage ? (
            <p className="text-sm text-ink">{copy.enhancementMessage}</p>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={onPrepareForPrint}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {finalizationStatus === "needs_review" ? "Try Again" : copy.actionLabel}
          </button>
        </>
      ) : null}
    </div>
  );
}

function capitalize(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
