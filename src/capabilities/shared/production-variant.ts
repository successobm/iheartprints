/**
 * Print'em All Phase 3 (V1 multi-variant package) — Existing Artwork's
 * production output is not one file with one fate; it is a small, fixed set
 * of independent PRODUCTION VARIANTS derived from the same operator-approved
 * source, each with its own job, its own status, and its own file.
 *
 * WHY THIS MODULE EXISTS SEPARATELY FROM `production-treatment.ts`
 *
 * `production-treatment.ts` answers "what is the project's CURRENT treatment
 * configuration?" — a single, mutable, in-progress choice. This module
 * answers a different question: "for a GIVEN treatment identity, what is the
 * durable, already-decided outcome?" The two must never be conflated — that
 * conflation (reading a single project-wide `finalization` verdict as though
 * it described whichever treatment happened to be selected) was exactly the
 * Phase 27O defect: a Standard Raster failure kept reading as a DTF Halftone
 * failure for over an hour after the treatment was switched, because nothing
 * in the status derivation asked "whose job was this?"
 *
 * V1 SCOPE. Exactly two variants: `standard_raster` and `halftone_dtf`.
 * Future variants (vector, screen-print separations, ...) are a later,
 * explicit product decision — this module does not anticipate them.
 *
 * NO NEW PERSISTENCE. Every fact here is derived, read-only, from
 * `FinalArtworkJob` + its production `AssetRecord` + its
 * `ProductionAssetValidation` — the exact records Phase 27O's audit proved
 * already carry full treatment-keyed provenance (Gate A). Nothing is
 * invented, migrated, or duplicated.
 */

import type { FinalArtworkJobStatus } from "@/lib/domain/types";

/** V1's fixed, ordered variant family. Do not add a third without a product decision. */
export const PRODUCTION_VARIANT_TREATMENTS = ["standard_raster", "halftone_dtf"] as const;
export type ProductionVariantTreatment = (typeof PRODUCTION_VARIANT_TREATMENTS)[number];

/**
 * A variant's customer/operator-facing status. Deliberately the SAME
 * vocabulary `CustomerFinalizationStatus` already uses for the single-slot
 * view (`not_requested`→`not_created`, `preparing`→`processing`,
 * `retryable_failure`→`retryable_failure`, `needs_review`→`needs_attention`,
 * `print_ready`→`print_ready`) — this is the same question asked per
 * variant instead of once for the whole project.
 */
export type ProductionVariantStatus =
  | "not_created"
  | "processing"
  | "print_ready"
  | "needs_attention"
  | "retryable_failure";

/**
 * Derives a SINGLE variant's status purely from ITS OWN job and validation
 * record — never from `PrintProject.status`, which is a shared, last-write-
 * wins field across every treatment a project has ever tried. This is the
 * one function whose absence in the pre-existing single-slot view (which
 * read `PrintProject.status` directly) caused Phase 27O's stale verdict.
 *
 * `job === null` — nothing has ever been enqueued for this exact treatment
 * identity: `not_created`. Distinct from a job that ran and reached an
 * honest "cannot auto-finalize" conclusion.
 *
 * In-flight statuses (`queued`/`running`/`recoverable`) read as `processing`.
 *
 * `failed` — an infrastructure problem (Phase 27M/27O: never a print-
 * readiness verdict since the Phase 27M fix) — reads as `retryable_failure`,
 * the one status where trying again with unchanged inputs might genuinely
 * help.
 *
 * `cancelled` — superseded by a later intent change, never a failure. Reads
 * as `not_created`: the honest offer is to ask again, not to see a verdict
 * about work that was deliberately set aside.
 *
 * `completed` — the worker reached a conclusion. Validation `status ===
 * "ready"` is `print_ready`; anything else (including no validation record
 * at all, which should not happen for a genuinely completed job but is read
 * conservatively) is `needs_attention` — a durable, honest verdict, not an
 * infrastructure hiccup, so no false "try again and it might work" promise.
 */
export function describeProductionVariantStatus(
  jobStatus: FinalArtworkJobStatus | null,
  validationStatus: string | null,
): ProductionVariantStatus {
  if (jobStatus === null) return "not_created";
  if (jobStatus === "queued" || jobStatus === "running" || jobStatus === "recoverable") {
    return "processing";
  }
  if (jobStatus === "failed") return "retryable_failure";
  if (jobStatus === "cancelled") return "not_created";
  // "completed"
  return validationStatus === "ready" ? "print_ready" : "needs_attention";
}

/**
 * Plain-language reason a variant is not (yet) print-ready, derived from the
 * FIRST blocking-failed check in its validation report. Deliberately a small,
 * closed mapping — never the raw internal check name or reason string
 * (Constitution §6.6): an unrecognized check falls back to a generic,
 * still-honest sentence rather than leaking implementation vocabulary.
 *
 * `null` when there is nothing to explain (not_created, processing, or
 * print_ready — a reason is only ever shown for `needs_attention` /
 * `retryable_failure`).
 */
export function describeVariantAttentionReason(
  treatment: ProductionVariantTreatment,
  firstBlockingFailedCheck: string | null,
): string | null {
  if (firstBlockingFailedCheck === null) return null;

  if (
    firstBlockingFailedCheck === "reconstruction_sufficiency" ||
    firstBlockingFailedCheck === "effective_resolution" ||
    firstBlockingFailedCheck === "minimum_raster_dimensions"
  ) {
    return "Standard Raster needs additional image enhancement at this print size.";
  }
  if (firstBlockingFailedCheck === "halftone_tonal_sufficiency") {
    return "This artwork does not carry enough tonal detail for the selected halftone screen at this print size.";
  }
  return treatment === "standard_raster"
    ? "Standard Raster needs another look before it can be finished."
    : "DTF Halftone needs another look before it can be finished.";
}

/**
 * Phase 28H Section 10 — DETERMINISTIC vs. OTHER, as actual internal
 * evidence rather than an inference from the top-level `needs_attention`/
 * `finalization_required` string alone. `standard_raster`'s validation
 * profile has several OTHER blocking checks entirely unrelated to
 * insufficient resolution (`aspect_ratio_preserved`, `alpha_bound_artwork`,
 * `transparent_dead_canvas`, `physical_width_policy`, ...) — any of those
 * failing also produces `needs_attention`, but calling THAT "Needs
 * Additional Enhancement" would misdescribe a distortion or dead-canvas
 * defect as a resolution problem. This reuses the exact same three checks
 * `describeVariantAttentionReason` already keys its specific sentence off
 * of — one classification, read from the SAME evidence, never duplicated
 * or re-inferred from displayed text.
 */
export type VariantAttentionKind = "deterministic_enhancement" | "other";

export function classifyVariantAttentionKind(
  firstBlockingFailedCheck: string | null,
): VariantAttentionKind | null {
  if (firstBlockingFailedCheck === null) return null;
  if (
    firstBlockingFailedCheck === "reconstruction_sufficiency" ||
    firstBlockingFailedCheck === "effective_resolution" ||
    firstBlockingFailedCheck === "minimum_raster_dimensions"
  ) {
    return "deterministic_enhancement";
  }
  return "other";
}

/**
 * Non-monetary, structural cost facts derived from a job's own recorded
 * provider identity — never a dollar figure (Phase 27P Gate: no pricing data
 * exists anywhere in this repository; see the phase report). Safe to show
 * to an internal operator deciding what these files actually cost to
 * produce, without inventing a number nobody can stand behind.
 */
export interface ProductionVariantCostSummary {
  /** The provider that actually ran, or `null` when no job has ever run. */
  provider: string | null;
  /**
   * Requests that left this process for a paid provider. Currently always 0
   * or 1: every provider in this build makes at most one external request
   * per completed job (Topaz's own internal poll loop is one logical
   * request; the local providers never leave the process at all).
   */
  externalProviderCalls: number;
  /** True only when the provider that ran is a metered, paid service (Topaz). */
  paidProviderUsed: boolean;
  /** `job.attempts - 1`, floored at 0 — how many times this exact job was retried after its first attempt. */
  retryCount: number;
}

/**
 * The first blocking-severity failed check in a persisted validation report,
 * or `null` when there isn't one (report missing, malformed, or every
 * blocking check passed). Loosely typed — `ProductionAssetValidation.report`
 * is `Record<string, unknown>` at the domain boundary on purpose (mirrors
 * `AssetRecord.metadata`) to avoid a domain → capabilities import cycle.
 */
export function firstBlockingFailedCheck(
  report: Record<string, unknown> | null | undefined,
): string | null {
  if (!report) return null;
  const checks = (report as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return null;
  for (const entry of checks) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (rec.status === "fail" && rec.severity === "blocking" && typeof rec.check === "string") {
      return rec.check;
    }
  }
  return null;
}

const PAID_PROVIDER_KEYS = new Set(["topaz_transparency_upscale"]);

export function describeProductionVariantCostSummary(
  job: { attempts: number; providerKey: string | null } | null,
  assetProviderRequestId: string | null,
): ProductionVariantCostSummary {
  if (!job) {
    return { provider: null, externalProviderCalls: 0, paidProviderUsed: false, retryCount: 0 };
  }
  const paidProviderUsed = job.providerKey !== null && PAID_PROVIDER_KEYS.has(job.providerKey);
  return {
    provider: job.providerKey,
    externalProviderCalls: paidProviderUsed && assetProviderRequestId ? 1 : 0,
    paidProviderUsed,
    retryCount: Math.max(0, job.attempts - 1),
  };
}

/** Customer-safe label for a variant treatment. Never "raster"/"halftone" jargon alone. */
export function productionVariantLabel(treatment: ProductionVariantTreatment): string {
  return treatment === "standard_raster" ? "Standard Raster" : "DTF Halftone";
}

/** One short, honest sentence about what each variant IS — never a claim that one is universally "better". */
export function productionVariantDescription(treatment: ProductionVariantTreatment): string {
  return treatment === "standard_raster"
    ? "Full-color continuous-tone production artwork."
    : "Alternative production artwork using a halftone dot screen, optimized for DTF.";
}

export interface ProductionVariantView {
  treatment: ProductionVariantTreatment;
  label: string;
  description: string;
  status: ProductionVariantStatus;
  /** Present only when a job has ever been enqueued for this exact treatment identity. */
  finalArtworkJobId: string | null;
  /** Present only when `status === "print_ready"`. */
  finalAssetId: string | null;
  createdAt: string | null;
  physicalWidthIn: number | null;
  physicalHeightIn: number | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  /** Only for `halftone_dtf`, and only once its settings are known (persisted or in-progress). */
  halftone: { lpi: number; angleDeg: number; dotShape: string } | null;
  /** Plain-language reason, or `null` when there is nothing to explain (see `describeVariantAttentionReason`). */
  attentionReason: string | null;
  /** Phase 28H Section 10: the SAME evidence `attentionReason` was derived from, exposed as a stable kind rather than requiring callers to pattern-match display text. `null` alongside `attentionReason === null`. */
  attentionKind: VariantAttentionKind | null;
  costSummary: ProductionVariantCostSummary;
}

export interface PrintReadyPackageView {
  variants: ProductionVariantView[];
}

/**
 * The one, concise, plain-language sentence about the PACKAGE as a whole —
 * Section 8's guidance. Never explains LPI/PPI engineering in this primary
 * copy (the per-variant `attentionReason` already carries what little
 * technical framing is needed, and even that stays plain-language).
 *
 * `null` when there is nothing worth saying yet — no variant has reached a
 * terminal state, or only one has and there is no other variant's outcome to
 * contrast it with.
 */
export function describePackageGuidance(variants: ProductionVariantView[]): string | null {
  const ready = variants.filter((v) => v.status === "print_ready");
  const notReady = variants.filter(
    (v) => v.status === "needs_attention" || v.status === "retryable_failure",
  );

  if (ready.length >= 2) {
    return "Both files are print ready. Your printer can choose the version that works best for their equipment and production process.";
  }
  if (ready.length === 1 && notReady.length >= 1) {
    const readyLabel = ready[0].label;
    const reason = notReady[0].attentionReason;
    return reason
      ? `Your ${readyLabel} file is print ready. ${reason}`
      : `Your ${readyLabel} file is print ready. The other variant is not currently available.`;
  }
  return null;
}
