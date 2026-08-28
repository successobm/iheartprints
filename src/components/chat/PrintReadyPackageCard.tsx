"use client";

import type { ProductionVariantView } from "@/capabilities/shared/production-variant";

export interface PrintReadyPackageCardProps {
  projectId: string;
  variants: ProductionVariantView[];
  guidance: string | null;
  /**
   * Phase 28I: the OPTIONAL "Create DTF Halftone Version" action — offered
   * only once Standard Raster is genuinely `print_ready` (see
   * `halftoneOffered` below). Absent (or the halftone variant already
   * having a status of its own) means no offer renders.
   */
  onCreateHalftoneVersion?: () => void;
  /** True from the moment "Create DTF Halftone Version" is clicked until that request's own response returns. */
  creatingHalftoneVersion?: boolean;
}

/**
 * Print'em All Phase 3 (V1 multi-variant package) — THE PRINT-READY FILES
 * SURFACE.
 *
 * Presents each production variant (Standard Raster, DTF Halftone)
 * INDEPENDENTLY: its own status, its own settings summary, its own download.
 * Never a single "here is the file" slot — that shape is exactly what
 * Phase 27O's audit found could not represent two variants that succeed or
 * fail on entirely independent schedules.
 *
 * Every fact rendered here (`variants`, `guidance`) is server-computed
 * (`production-variant.ts`) from each variant's OWN job/asset/validation
 * provenance — this component infers nothing from which treatment happens
 * to be selected in the controls elsewhere on the page, and never will: see
 * `ProductionVariantView`'s doc for why that inference is exactly the
 * defect this surface exists to rule out.
 *
 * Phase 28H: this is now also where the OPTIONAL second-variant offer lives.
 * The product decision (Phase 28H §1) is that Standard Raster is always
 * attempted FIRST, automatically, with no customer treatment choice
 * beforehand.
 *
 * Phase 28I HARD CORRECTION: DTF Halftone is now offered ONLY once Standard
 * Raster is genuinely `print_ready` — not `needs_attention`, not
 * `retryable_failure`, not any other non-`print_ready` state. Phase 28H's
 * rule (any TERMINAL Raster state unlocked Halftone, on the theory that a
 * Raster enhancement need must never block a Halftone attempt that can
 * succeed independently) is EXPLICITLY OVERRULED by product policy: Standard
 * Raster must succeed first, with no bypass, before Halftone is even
 * offered. There is still no "create Standard Raster" affordance here — it
 * remains the default, automatic first attempt — so this card now only
 * ever offers ONE thing to create, and only after the one thing that must
 * come first has genuinely succeeded.
 *
 * This is a UI-ONLY gate; do not rely on it for integrity. The
 * authoritative enforcement is server-side, in
 * `FinalArtworkCapability.requestPreparedUploadFinalArtwork` — a direct
 * `POST /production-treatment` + `POST /artwork-preparation` sequence
 * cannot bypass this rule by skipping the button (Section 10).
 */
export function PrintReadyPackageCard({
  projectId,
  variants,
  guidance,
  onCreateHalftoneVersion,
  creatingHalftoneVersion,
}: PrintReadyPackageCardProps) {
  if (variants.length === 0) return null;

  const raster = variants.find((v) => v.treatment === "standard_raster") ?? null;
  const halftoneOffered =
    raster !== null &&
    raster.status === "print_ready" &&
    variants.some((v) => v.treatment === "halftone_dtf" && v.status === "not_created");

  return (
    <section
      aria-label="Print-ready files"
      className="mt-4 rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
    >
      <p className="text-sm font-semibold text-ink">Print-Ready Files</p>

      {guidance ? (
        <p className="mt-1.5 text-sm text-muted">{guidance}</p>
      ) : null}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {variants.map((variant) =>
          variant.treatment === "halftone_dtf" && halftoneOffered ? (
            <HalftoneOfferCard
              key={variant.treatment}
              onCreateHalftoneVersion={onCreateHalftoneVersion}
              creatingHalftoneVersion={creatingHalftoneVersion ?? false}
            />
          ) : (
            <VariantCard key={variant.treatment} projectId={projectId} variant={variant} />
          ),
        )}
      </div>
    </section>
  );
}

/**
 * Phase 28H §6/§7: the OPTIONAL DTF Halftone offer, shown in place of the
 * plain "Not Created" tile once Standard Raster has concluded. Deliberately
 * does not explain halftones as a prerequisite to understand Standard
 * Raster — this card only ever appears AFTER the customer already has (or
 * has attempted) their normal artwork.
 */
function HalftoneOfferCard({
  onCreateHalftoneVersion,
  creatingHalftoneVersion,
}: {
  onCreateHalftoneVersion?: () => void;
  creatingHalftoneVersion: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-black/8 border-dashed p-3" data-halftone-offer>
      <p className="text-xs font-semibold uppercase tracking-wide text-ink">
        DTF Halftone <span className="font-normal normal-case text-muted">— Optional</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        Alternative DTF-ready artwork using a halftone dot screen. Some printers may prefer this version for DTF
        production.
      </p>

      <div className="mt-2.5">
        {creatingHalftoneVersion ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-medium text-muted"
            data-halftone-offer-status
          >
            <span className="inline-flex gap-0.5" aria-hidden="true">
              <span className="animate-pulse">●</span>
              <span className="animate-pulse [animation-delay:150ms]">●</span>
              <span className="animate-pulse [animation-delay:300ms]">●</span>
            </span>
            Creating…
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-medium text-muted"
            data-halftone-offer-status
          >
            Not Created
          </span>
        )}
      </div>

      <button
        type="button"
        disabled={creatingHalftoneVersion || !onCreateHalftoneVersion}
        onClick={onCreateHalftoneVersion}
        className="mt-3 inline-flex rounded-full border border-black/10 px-3.5 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
        data-action="create-halftone-version"
      >
        Create DTF Halftone Version
      </button>
    </div>
  );
}

function VariantCard({
  projectId,
  variant,
}: {
  projectId: string;
  variant: ProductionVariantView;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-black/8 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink">
        {variant.label}
      </p>
      <p className="mt-1 text-xs text-muted">{variant.description}</p>

      {variant.halftone ? (
        <p className="mt-1 text-[11px] text-muted">
          {variant.halftone.lpi} LPI · {variant.halftone.angleDeg}° ·{" "}
          {capitalize(variant.halftone.dotShape)}
        </p>
      ) : null}

      <div className="mt-2.5">
        <StatusBadge variant={variant} />
      </div>

      {variant.attentionReason ? (
        <p className="mt-1.5 text-xs text-amber-800">{variant.attentionReason}</p>
      ) : null}

      {variant.status === "print_ready" ? (
        <a
          href={`/api/projects/${projectId}/production-artwork/${variant.treatment}/download`}
          className="mt-3 inline-flex rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-ink/90"
        >
          Download PNG
        </a>
      ) : null}
    </div>
  );
}

function StatusBadge({ variant }: { variant: ProductionVariantView }) {
  const { label, className } = statusPresentation(variant);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${className}`}
    >
      {variant.status === "processing" ? (
        <span className="inline-flex gap-0.5" aria-hidden="true">
          <span className="animate-pulse">●</span>
          <span className="animate-pulse [animation-delay:150ms]">●</span>
          <span className="animate-pulse [animation-delay:300ms]">●</span>
        </span>
      ) : null}
      {label}
    </span>
  );
}

function statusPresentation(variant: ProductionVariantView): {
  label: string;
  className: string;
} {
  switch (variant.status) {
    case "print_ready":
      return { label: "✓ Print Ready", className: "bg-emerald-50 text-emerald-700" };
    case "needs_attention":
      // Phase 28H Section 10: gated on the ACTUAL validation evidence
      // (`attentionKind`, derived from the specific blocking check that
      // failed) rather than blanket-labelling every Standard Raster
      // `needs_attention` this way. Standard Raster's own profile has other
      // blocking checks entirely unrelated to insufficient resolution
      // (aspect-ratio distortion, dead canvas, alpha-bound artwork, ...) —
      // calling one of THOSE "Needs Additional Enhancement" would misdescribe
      // a different defect as a resolution problem. Only the three checks
      // `classifyVariantAttentionKind` recognizes as "deterministic
      // enhancement" get the more specific label; everything else (an
      // unrelated Standard Raster defect, or any Halftone verdict) keeps the
      // generic "Needs Attention".
      return variant.attentionKind === "deterministic_enhancement"
        ? { label: "Needs Additional Enhancement", className: "bg-amber-50 text-amber-800" }
        : { label: "Needs Attention", className: "bg-amber-50 text-amber-800" };
    case "retryable_failure":
      return { label: "Needs Attention", className: "bg-amber-50 text-amber-800" };
    case "processing":
      return { label: "Processing…", className: "bg-black/[0.04] text-muted" };
    case "not_created":
      return { label: "Not Created", className: "bg-black/[0.04] text-muted" };
  }
}

function capitalize(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}
