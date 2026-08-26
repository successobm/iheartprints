"use client";

import type { ProductionVariantView } from "@/capabilities/shared/production-variant";

export interface PrintReadyPackageCardProps {
  projectId: string;
  variants: ProductionVariantView[];
  guidance: string | null;
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
 */
export function PrintReadyPackageCard({
  projectId,
  variants,
  guidance,
}: PrintReadyPackageCardProps) {
  if (variants.length === 0) return null;

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
        {variants.map((variant) => (
          <VariantCard key={variant.treatment} projectId={projectId} variant={variant} />
        ))}
      </div>
    </section>
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
        <StatusBadge status={variant.status} />
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

function StatusBadge({ status }: { status: ProductionVariantView["status"] }) {
  const { label, className } = statusPresentation(status);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${className}`}
    >
      {status === "processing" ? (
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

function statusPresentation(status: ProductionVariantView["status"]): {
  label: string;
  className: string;
} {
  switch (status) {
    case "print_ready":
      return { label: "✓ Print Ready", className: "bg-emerald-50 text-emerald-700" };
    case "needs_attention":
      return { label: "Needs Attention", className: "bg-amber-50 text-amber-800" };
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
