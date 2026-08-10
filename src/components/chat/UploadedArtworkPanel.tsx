"use client";

import { useState } from "react";

import {
  describeApprovedPreparation,
  type ArtworkPreparationView,
} from "@/capabilities/artwork-preparation";
import { PRINT_PLACEMENT_LABELS } from "@/lib/domain/print-placement";
import type { PrintPlacement } from "@/lib/domain/types";
import { ArtworkComparison } from "./ArtworkComparison";
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
          onApprove={props.onApprove}
          onReconsider={props.onReconsider}
        />
      ) : null}

      {step === "approved" && preparation ? (
        <ApprovedStep
          preparation={preparation}
          originalImageUrl={props.originalImageUrl}
          preparedImageUrl={props.preparedImageUrl}
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
  onApprove,
  onReconsider,
}: {
  preparation: ArtworkPreparationView;
  busy: boolean;
  originalImageUrl: string | null;
  preparedImageUrl: string | null;
  onApprove: () => void;
  onReconsider: () => void;
}) {
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

      {preparation.customer.enhancementNeeded &&
      preparation.customer.resolutionMessage ? (
        <p className="mt-3 text-sm text-ink">
          {preparation.customer.resolutionMessage}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Approval is ONLY ever this explicit button. Opening either preview
            above does nothing but show a larger picture. */}
        <button
          type="button"
          disabled={busy}
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
  originalImageUrl,
  preparedImageUrl,
}: {
  preparation: ArtworkPreparationView;
  originalImageUrl: string | null;
  preparedImageUrl: string | null;
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
    </div>
  );
}

function capitalize(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
