import { ACQUISITION_UNAVAILABLE_MESSAGE } from "@/capabilities/acquisition";
import type {
  CustomerAcquisitionView,
  EmailCaptureResult,
} from "@/capabilities/acquisition";
import type { ArtworkPreparationView } from "@/capabilities/artwork-preparation";
import {
  describeSignPlanForCustomer,
  type SignDefectCode,
  type SignPlanCustomerView,
  type SignRepairPlan,
} from "@/capabilities/sign-preparation";
import type { CustomerPaymentView } from "@/capabilities/payment";
import { getCapabilityGraph } from "@/capabilities/composition";
import { decodeQrCodes, scanForQrFinderPatterns } from "@/capabilities/machine-readable-content/qr-detect-decode";
import { deriveRegionKey } from "@/capabilities/machine-readable-content/qr-resolution";
import { PNG } from "pngjs";
import type {
  DesignBriefDecisionAction,
  ProductionTreatmentRequest,
} from "@/capabilities/conversation";
import { productionSizeIsConfirmed } from "@/capabilities/shared/confirmed-production-size";
import {
  DEFAULT_HALFTONE_CHOKE_PX,
  DEFAULT_HALFTONE_LPI,
  DEFAULT_HALFTONE_MIDTONE,
  HALFTONE_DOT_SHAPES,
  HALFTONE_SCREEN_ANGLES,
  MAX_HALFTONE_CHOKE_PX,
  MAX_HALFTONE_LPI,
  MAX_HALFTONE_MIDTONE,
  MIN_HALFTONE_CHOKE_PX,
  MIN_HALFTONE_LPI,
  MIN_HALFTONE_MIDTONE,
  assessHalftoneEligibility,
  currentProductionTreatmentKey,
  productionTreatmentKey,
  recommendedHalftoneSettings,
  resolveGarmentColor,
  treatmentKeyMatchesJob,
  type GarmentColor,
  type HalftoneSettings,
  type ProductionTreatment,
} from "@/capabilities/shared/production-treatment";
import {
  PRODUCTION_VARIANT_TREATMENTS,
  classifyVariantAttentionKind,
  describeProductionVariantCostSummary,
  describeProductionVariantStatus,
  describeVariantAttentionReason,
  resolveAttentionCheckName,
  productionVariantDescription,
  productionVariantLabel,
  type PrintReadyPackageView,
  type ProductionVariantTreatment,
  type ProductionVariantView,
} from "@/capabilities/shared/production-variant";
import {
  toCustomerArtworkVersions,
  toCustomerConceptStatusView,
  type CustomerArtworkVersion,
  type CustomerConceptStatusView,
} from "@/capabilities/shared/contracts";
import {
  describePrintReadySize,
  type PrintReadySizeView,
} from "@/capabilities/shared/print-ready-size";
import { getProjectRepository } from "@/lib/db";
import {
  isUnsupportedRequestedProductionOutput,
  productionIntentMatches,
} from "@/lib/domain/types";
import type {
  FinalArtworkJob,
  FinalArtworkJobStatus,
  GarmentSizeClass,
  ProjectSnapshot,
  ProjectStatus,
  SignPlanAuthorizationActor,
  SignPreparation,
  StoredRequestedProductionOutput,
} from "@/lib/domain/types";
import { printPlacementLabel } from "@/lib/domain/print-placement";
import {
  maybeRecoverStrandedLocalFinalArtworkJobs,
  maybeTriggerLocalFinalArtworkWorker,
  type LocalFinalArtworkTriggerReason,
} from "@/lib/services/local-final-artwork-trigger";
import {
  maybeRecoverStrandedLocalGenerationJobs,
  maybeTriggerLocalGenerationWorker,
  type LocalGenerationTriggerReason,
} from "@/lib/services/local-generation-trigger";
import { buildPrintReadyFilename } from "@/lib/services/print-ready-filename";

/**
 * Stable facade for API routes and existing tests.
 * Delegates to the ConversationCapability composition root.
 *
 * Sprint 2G Part 3: every snapshot-returning function also attaches
 * `conceptStatus` — computed fresh from already-public snapshot data via
 * `ConceptGenerationCapability.describeConceptStatus`, not a new capability
 * dependency — so the UI's persistent concept-status action reflects
 * reality on every fetch, not only right after a revision turn.
 *
 * Sprint 2K Phase 1: this is also the one place that shapes `ArtworkVersion`
 * into the browser-safe `CustomerArtworkVersion` (see contracts.ts) before
 * it leaves the server — every route funnels through the functions below,
 * so there is a single choke point rather than per-route sanitization.
 */

/**
 * Sprint 2M Phase 2B/2C: customer-safe finalization state. Project terminal
 * states (`print_ready`, `finalization_required`) remain authoritative.
 * While the project is still `finalizing`, the current FinalArtworkJob
 * distinguishes in-progress work from a retryable infrastructure failure
 * — never a raw job id, provider name, `lastError`, or validation rule
 * (Goal 13/16). `"needs_review"` is a print-readiness verdict, not a
 * storage hiccup; `"retryable_failure"` is the latter and reuses the
 * existing Prepare action (no second retry API).
 */
export type CustomerFinalizationStatus =
  | "not_requested"
  | "preparing"
  | "retryable_failure"
  | "needs_review"
  | "print_ready";

export interface CustomerFinalizationView {
  status: CustomerFinalizationStatus;
}

/**
 * Pure customer-view derivation. Exported for tests; routes still go
 * through `getFinalizationStatus` / the snapshot choke point.
 *
 * Sprint A2 Correction 2 (Goal 8 / Goal 18): this now answers "how is the
 * customer's CURRENT request doing?", which is not the same question as
 * "what is `project.status`?".
 *
 * `project.status` is a durable record of the last thing the pipeline
 * achieved. It is genuinely useful and it is not wrong — but it is about the
 * PAST. A customer who has a `print_ready` PNG and has since asked for
 * separations has a real, valid plate on file AND an unmet request, and
 * showing them "print ready" answers a question they stopped asking. So the
 * derivation is anchored on current intent first:
 *
 *   1. Current request is unsupported (or unreadable) → `needs_review`,
 *      regardless of `project.status`. We do not claim to have produced what
 *      we do not produce. The previously produced PNG is NOT deleted — it
 *      simply stops being the answer.
 *   2. Otherwise the current request is the Production PNG, and the job
 *      bound to THAT intent is what speaks. A stale `failed` job for an
 *      abandoned intent cannot show a retry prompt for work nobody wants,
 *      and a `cancelled` (superseded) job reads as "not requested" — the
 *      customer can simply ask again.
 *
 * `projectStatus` still decides between `print_ready` and `needs_review`
 * once the matching job has completed, because that is exactly the fact it
 * durably records: whether authoritative validation passed.
 */
export function toCustomerFinalizationView(
  projectStatus: ProjectStatus,
  latestJobStatus: FinalArtworkJobStatus | null = null,
  currentRequestedProductionOutput: StoredRequestedProductionOutput | null = null,
  /**
   * Whether a FinalArtworkJob bound to the CURRENT requested output exists at
   * all. Defaults to `true`, which preserves the pre-A2 contract for callers
   * that only know a project status — every such caller predates requestable
   * outputs, so "the job for what they are asking" is the only job there
   * could be.
   */
  matchingJobExists: boolean = true,
  /**
   * Sprint A2 Correction 3: whether a completed job, under the current
   * authority and bound to the current intent, has a production asset with
   * `ready` authoritative validation. Defaults to `false` so callers that
   * only know a project status keep their existing behavior.
   */
  currentRequestSatisfied: boolean = false,
): CustomerFinalizationView {
  // (1) The current request is one this product does not produce — or one an
  // older build cannot read (fail closed). Nothing achieved earlier, for a
  // different request, can make THIS one satisfied.
  if (isUnsupportedRequestedProductionOutput(currentRequestedProductionOutput)) {
    return { status: "needs_review" };
  }

  // (2) Sprint A2 Correction 3: a completed job already satisfies the current
  // request, proven by the same evidence the delivery routes use. Ahead of
  // `project.status` deliberately — that status records what the pipeline
  // last achieved, and after a PNG → unsupported → PNG round trip it is
  // stale (`finalization_required`, written by the unsupported job) while
  // the customer's actual plate is valid, current, and downloadable. Sharing
  // one source with delivery is also what makes "says print_ready" and "the
  // download works" impossible to disagree.
  if (currentRequestSatisfied) return { status: "print_ready" };

  // (3) Nothing has been enqueued for what the customer is asking for now.
  // `project.status` may well be a terminal state — but it is a terminal
  // state about a DIFFERENT request, and reporting it here would either
  // claim work that was never done or strand the customer on a `needs_review`
  // screen with no way to ask again. `not_requested` restores the Prepare
  // action, which is exactly what they need.
  if (!matchingJobExists) return { status: "not_requested" };

  // (3) The matching job was superseded by an intent change and then not
  // resumed. Same reasoning: offer the action rather than a stale verdict.
  if (latestJobStatus === "cancelled") return { status: "not_requested" };

  // Print'em All Phase 3 (Phase 27P): a COMPLETED job for the current intent
  // that did NOT satisfy it (`currentRequestSatisfied` is already known
  // `false` by this point) is itself a durable, honest verdict — the exact
  // shape Phase 27M's fix produces for a genuine print-readiness refusal.
  // That verdict must never be overridden by `project.status` still reading
  // `"print_ready"` from a DIFFERENT, earlier-satisfied treatment/intent
  // (Phase 27P's multi-variant package: switching from a successful DTF
  // Halftone run back to Standard Raster leaves `project.status` at
  // `"print_ready"` — truthfully, about halftone — while Standard Raster's
  // own latest job completed without satisfying anything). Checked ahead of
  // the `projectStatus` fallback below for exactly that reason: this is the
  // CURRENT job's own conclusion, and it is always more current than a
  // shared, last-write-wins project field.
  if (latestJobStatus === "completed") return { status: "needs_review" };

  // (4) Project terminal states, which durably record what authoritative
  // validation concluded for a job bound to this same intent. These stay
  // ahead of job status on purpose: a `print_ready` project must not be
  // dragged back to a retry prompt by an older failed attempt that a later
  // one already superseded.
  if (projectStatus === "print_ready") return { status: "print_ready" };
  if (projectStatus === "finalization_required") return { status: "needs_review" };
  if (projectStatus === "finalizing") {
    if (latestJobStatus === "failed") return { status: "retryable_failure" };
    return { status: "preparing" };
  }
  return { status: "not_requested" };
}

/**
 * The job that currently owns customer-facing finalization: active Create
 * New approval's job, or the newest job on an approved upload preparation.
 * Older failed jobs on a superseded approval or earlier print size must
 * not leak into the view.
 *
 * Print'em All Phase 3 (Phase 27O fix): also matched against the project's
 * CURRENT production-treatment identity, exactly as
 * `resolveCurrentMatchingProductionJob` (the delivery/download resolver) has
 * always done. Before this, a job's TREATMENT was never part of "is this the
 * current one?" for STATUS purposes — only its requested output was — so a
 * failed Standard Raster attempt kept reading as the verdict for whatever
 * treatment was later selected, including one (DTF Halftone) that had never
 * even been attempted. `treatmentKeyMatchesJob` is the same helper the
 * stale-intent fence uses, so a legacy job (`null` key) still abstains to
 * "standard raster" rather than being newly excluded.
 */
async function resolveCurrentFinalArtworkJob(
  projectId: string,
  currentIntent: StoredRequestedProductionOutput | null,
  currentTreatmentKey: string,
): Promise<FinalArtworkJob | null> {
  try {
    const repo = getProjectRepository();
    // Sprint A2 Correction 2 (Goal 18): "the current job" means the job bound
    // to the intent the customer is asking for NOW. A job created for a
    // different requested output is not this project's current finalization,
    // however recently it ran — that is precisely how a stale `failed` PNG
    // job used to show a retry prompt to someone who had moved on to
    // separations, and how a completed unsupported job used to speak for a
    // customer who had retracted back to PNG.
    const matchesIntent = (job: FinalArtworkJob) =>
      productionIntentMatches(job.requestedProductionOutput, currentIntent) &&
      treatmentKeyMatchesJob(currentTreatmentKey, job.productionTreatmentKey);

    const approval = await repo.getActiveFinalDirectionApproval(projectId);
    if (approval) {
      const jobs = await repo.listFinalArtworkJobsForApproval(projectId, approval.id);
      return jobs.filter(matchesIntent).at(-1) ?? null;
    }

    const preparation = await repo.getArtworkPreparation(projectId);
    if (!preparation || preparation.status !== "approved") return null;

    const jobs = await repo.listFinalArtworkJobsForPreparation(
      projectId,
      preparation.id,
    );
    return jobs.filter(matchesIntent).at(-1) ?? null;
  } catch {
    return null;
  }
}

async function customerFinalizationViewForProject(
  projectId: string,
  projectStatus: ProjectStatus,
  currentIntent: StoredRequestedProductionOutput | null,
  currentTreatmentKey: string,
): Promise<CustomerFinalizationView> {
  // Sprint A2 Correction 2: the matching job is resolved for EVERY project
  // status now, not only `"finalizing"`. A project sitting at `print_ready`
  // still has to answer "…for the thing you are currently asking for?", and
  // that answer lives in whether a job bound to the current intent exists and
  // how it ended.
  const job = await resolveCurrentFinalArtworkJob(projectId, currentIntent, currentTreatmentKey);
  // Sprint A2 Correction 3: the same evidence the delivery routes resolve on,
  // read through the same capability, so the state a customer is shown and
  // the file they can actually download can never disagree.
  const satisfied = await getCapabilityGraph()
    .finalArtwork.resolveCurrentProductionDelivery(projectId)
    .catch(() => null);
  return toCustomerFinalizationView(
    projectStatus,
    job?.status ?? null,
    currentIntent,
    // Whether the project has ever had a job for THIS request. Distinguished
    // from "the job exists and is in some state" because the two mean
    // genuinely different things to a customer: nothing enqueued yet vs. a
    // verdict already reached.
    job !== null,
    satisfied !== null,
  );
}

export type ApiProjectSnapshot = Omit<ProjectSnapshot, "artworkVersions"> & {
  artworkVersions: CustomerArtworkVersion[];
  conceptStatus: CustomerConceptStatusView;
  finalization: CustomerFinalizationView;
  /**
   * Live Acceptance Cleanup (Issue 5): the physical size the selected
   * concept will be prepared at, so the customer can decide before
   * finalization starts rather than discovering it afterwards. `null` when
   * there is nothing to state honestly — no concept selected, or no print
   * placement known yet. Every figure is derived server-side from the one
   * placement policy table; no client component computes inches.
   */
  printReadySize: PrintReadySizeView | null;
  /**
   * Existing Artwork → Print Ready Phase 1: the Upload Existing Artwork
   * workflow's state, already phrased for the customer (no analysis numbers,
   * no asset ids, no storage keys). `null` for every Create New Artwork
   * project — and that `null` IS the workflow identity the UI branches on,
   * which is why Phase 1 needs no workflow enum anywhere.
   */
  artworkPreparation: ArtworkPreparationView | null;
  /**
   * LIVE PRODUCT BLOCKER #1: the rigid-sign authority's own customer-safe
   * state — whether a `SignPreparation` exists for this project and its
   * human-confirmed ordered size. `null` for every project that has not
   * been identified as a Sign, exactly mirroring how `artworkPreparation`
   * is `null` for every Create New Artwork project. Deliberately narrow:
   * inspection, defects, and repair-plan detail belong to a later,
   * separately-approved Signs phase (`AGENTS.md`'s Signs guardrail) and
   * are never phrased for a customer here.
   */
  signArtwork: SignArtworkView | null;
  /**
   * Sprint A4: where this session stands in the acquisition funnel, already
   * phrased for the customer. Never the persisted entitlement value, never
   * the acquisition session id, never the captured email ADDRESS — the UI
   * needs to know whether a gate is open, not who is behind it, and the
   * cheapest way to keep an address out of caches, logs, and screenshots is
   * to never put it in a response (Goal 19).
   */
  acquisition: CustomerAcquisitionView;
  /**
   * Sprint A5.5: where this project stands commercially, already phrased for
   * the customer.
   *
   * Carries a server-FORMATTED display amount and nothing else monetary — no
   * raw minor units, no currency code, no provider price id, no checkout
   * session id, no payment intent id, no internal transaction id, and no
   * configuration detail. The UI needs to know whether to offer a purchase
   * and what to say it costs; every other fact stays server-side.
   */
  payment: CustomerPaymentView;
  /**
   * Print'em All Phase 2: the internal operator's production-treatment
   * surface.
   *
   * OPTIONAL, and absent entirely — not `null` — for every project that is
   * not an internal operator's. A `null` field would still tell a public
   * customer's browser that an internal production tier exists; an absent key
   * tells it nothing. This is presentation only: the server-side gate that
   * actually decides is
   * `ConversationCapability.selectProductionTreatment`, so a client that
   * synthesized this object would gain a rendered panel and no capability.
   */
  productionTreatment?: ProductionTreatmentView;
  /**
   * Print'em All Phase 3 (V1 multi-variant package): the fixed two-variant
   * (`standard_raster` / `halftone_dtf`) production package for the
   * Existing Artwork workflow — see `production-variant.ts`. Same presence
   * rule as `productionTreatment` (optional/absent, never `null`, internal
   * projects only) for the identical reason: this is where a variant a
   * customer does not yet have access to would otherwise leak.
   */
  printReadyPackage?: PrintReadyPackageView;
};

/**
 * Print'em All Phase 2: everything an operator's treatment panel renders,
 * resolved server-side.
 *
 * The panel computes nothing. Bounds, options, defaults, the resolved garment
 * colour, and whether the treatment can be offered at all are all decided by
 * the same domain module production uses, so a control can never offer a
 * value the pipeline would refuse.
 */
export interface ProductionTreatmentView {
  treatment: ProductionTreatment;
  /** The persisted settings, or `null` on standard raster. */
  halftone: HalftoneSettings | null;
  /** What "Reset to recommended" returns to. `null` when no garment colour resolves. */
  recommended: HalftoneSettings | null;
  /** When a human last chose a treatment. `null` = never = the default. */
  selectedAt: string | null;
  /** The resolved garment colour, for preview compositing. `null` when unresolvable. */
  garment: GarmentColor | null;
  /** Whether the halftone treatment may be OFFERED, and why not when it may not. */
  offerable: boolean;
  offerBlockedReason: string | null;
  /** The bounded control ranges. One definition, served to the UI rather than restated in it. */
  controls: {
    lpi: { min: number; max: number; recommended: number };
    angles: readonly number[];
    dotShapes: readonly string[];
    midtone: { min: number; max: number; recommended: number };
    chokePx: { min: number; max: number; recommended: number };
  };
}

/**
 * Print'em All Phase 2. Resolves the operator surface, or `undefined` when
 * this project is not an internal operator's.
 *
 * Never allowed to take down a snapshot — same advisory-not-a-gate rule the
 * acquisition and preparation views follow. A failure here hides a panel; it
 * does not break a page, and it cannot grant anything, because the write side
 * re-checks the entitlement independently.
 */
async function resolveProductionTreatmentView(
  snapshot: ProjectSnapshot,
  artworkPreparation: ArtworkPreparationView | null,
): Promise<ProductionTreatmentView | undefined> {
  const graph = getCapabilityGraph();
  try {
    if (!(await graph.acquisition.isInternalProject(snapshot.project.id))) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  const garment = resolveGarmentColor(snapshot.brief.shirtColor);
  // Reuses the preparation view this snapshot already resolved rather than
  // re-reading it. Two reads could disagree, and "is there an approved
  // prepared source?" must have one answer per snapshot.
  const preparedSourceAvailable = Boolean(
    artworkPreparation?.approved && artworkPreparation.hasPreparedArtwork,
  );

  const eligibility = assessHalftoneEligibility({
    productionCategory: "apparel_raster",
    productionSizeConfirmed: productionSizeIsConfirmed(snapshot.brief),
    preparedSourceAvailable,
    garment,
    // The tonal signal is measured only when the operator asks for a preview —
    // decoding the prepared raster on every snapshot read would be expensive
    // and, since tonal content is a SOFT signal an operator may override
    // anyway, would not change what this panel offers.
    tone: { visiblePixelCount: 1, midtoneFraction: 1 },
  });

  return {
    treatment: snapshot.brief.productionTreatment,
    halftone: snapshot.brief.halftoneSettings,
    recommended: garment ? recommendedHalftoneSettings(garment) : null,
    selectedAt: snapshot.brief.productionTreatmentSelectedAt,
    garment,
    offerable: eligibility.eligible,
    offerBlockedReason: eligibility.eligible ? null : eligibility.rationale,
    controls: {
      lpi: {
        min: MIN_HALFTONE_LPI,
        max: MAX_HALFTONE_LPI,
        recommended: DEFAULT_HALFTONE_LPI,
      },
      angles: HALFTONE_SCREEN_ANGLES,
      dotShapes: HALFTONE_DOT_SHAPES,
      midtone: {
        min: MIN_HALFTONE_MIDTONE,
        max: MAX_HALFTONE_MIDTONE,
        recommended: DEFAULT_HALFTONE_MIDTONE,
      },
      chokePx: {
        min: MIN_HALFTONE_CHOKE_PX,
        max: MAX_HALFTONE_CHOKE_PX,
        recommended: DEFAULT_HALFTONE_CHOKE_PX,
      },
    },
  };
}

/**
 * Print'em All Phase 3 — THE PACKAGE VIEW.
 *
 * Builds the fixed, two-variant (`standard_raster` / `halftone_dtf`)
 * print-ready package for an Existing Artwork project: what each variant's
 * status, file, and cost facts are RIGHT NOW, independent of which treatment
 * the operator currently has selected.
 *
 * Gated exactly like `resolveProductionTreatmentView` (internal projects
 * only, absent rather than `null` for everyone else) — this is presentation
 * of the same authority, never a second one; the server-side write path
 * (`selectProductionTreatment`, `requestPreparedUploadFinalArtwork`) is
 * unchanged and remains the only real gate.
 *
 * No new persistence. Every fact is derived, read-only, from existing
 * `FinalArtworkJob` / `AssetRecord` / `ProductionAssetValidation` records via
 * `FinalArtworkCapability.resolveProductionVariantState` (Phase 27P Gate A).
 */
async function resolvePrintReadyPackage(
  snapshot: ProjectSnapshot,
  artworkPreparation: ArtworkPreparationView | null,
): Promise<PrintReadyPackageView | undefined> {
  const graph = getCapabilityGraph();
  try {
    if (!(await graph.acquisition.isInternalProject(snapshot.project.id))) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  // A package is only meaningful once there is an approved uploaded source
  // to build variants FROM — mirrors the same guard `resolveProductionTreatmentView`
  // effectively applies via `preparedSourceAvailable`.
  if (!artworkPreparation?.approved || !artworkPreparation.hasPreparedArtwork) {
    return undefined;
  }

  const variants: ProductionVariantView[] = [];
  for (const treatment of PRODUCTION_VARIANT_TREATMENTS) {
    variants.push(
      await resolveOneProductionVariant(graph, getProjectRepository(), snapshot, treatment),
    );
  }
  return { variants };
}

/**
 * The treatment-key identity for ONE variant slot.
 *
 * Standard Raster has exactly one identity, always. DTF Halftone's identity
 * is the CURRENT working configuration when there is one (Section 14 — a
 * brand-new, not-yet-run LPI/angle/dot combination must show as its own
 * genuinely `not_created` variant, never silently merged into an older
 * configuration's result).
 *
 * THE PHASE 27P TRAP THIS GUARDS AGAINST. `selectProductionTreatment`'s
 * `standard_raster` branch calls `clearProductionTreatment`, which sets
 * `halftoneSettings` back to `null` — by design, since the brief's
 * `halftoneSettings` column is the CURRENT WORKING CONFIGURATION, not a
 * history. Reading ONLY that column for identity (this function's first
 * draft) meant that the instant an operator switched back to Standard
 * Raster, the halftone variant's own identity became unrecoverable — a
 * completed, print-ready DTF Halftone file would have silently reported
 * `not_created`, even though nothing about the file itself had changed.
 * That is exactly the "switching treatment invalidates a completed variant"
 * defect Section 0/6 explicitly forbids, just reached from the read side
 * instead of a write that deletes anything.
 *
 * So: when there is no CURRENT halftone configuration (because standard
 * raster is currently selected, or halftone was never configured at all),
 * fall back to the MOST RECENT halftone-family job's OWN recorded
 * `productionTreatmentKey` — never reconstructed from cleared settings,
 * always read from the job's own immutable, enqueue-time snapshot. `null`
 * only when neither a current configuration nor any historical job exists.
 */
async function resolveVariantTreatmentKey(
  repo: ReturnType<typeof getProjectRepository>,
  projectId: string,
  snapshot: ProjectSnapshot,
  treatment: ProductionVariantTreatment,
): Promise<string | null> {
  if (treatment === "standard_raster") {
    return productionTreatmentKey({ treatment: "standard_raster" });
  }
  if (snapshot.brief.halftoneSettings) {
    return productionTreatmentKey({
      treatment: "halftone_dtf",
      halftone: snapshot.brief.halftoneSettings,
    });
  }

  const approval = await repo.getActiveFinalDirectionApproval(projectId);
  const jobs = approval
    ? await repo.listFinalArtworkJobsForApproval(projectId, approval.id)
    : await resolveJobsForApprovedPreparation(repo, projectId);
  const halftoneJobs = jobs
    .filter((job) => job.productionTreatmentKey?.startsWith("halftone_dtf/"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return halftoneJobs.at(-1)?.productionTreatmentKey ?? null;
}

async function resolveJobsForApprovedPreparation(
  repo: ReturnType<typeof getProjectRepository>,
  projectId: string,
): Promise<FinalArtworkJob[]> {
  const preparation = await repo.getArtworkPreparation(projectId);
  if (!preparation || preparation.status !== "approved") return [];
  return repo.listFinalArtworkJobsForPreparation(projectId, preparation.id);
}

async function resolveOneProductionVariant(
  graph: ReturnType<typeof getCapabilityGraph>,
  repo: ReturnType<typeof getProjectRepository>,
  snapshot: ProjectSnapshot,
  treatment: ProductionVariantTreatment,
): Promise<ProductionVariantView> {
  const emptyCostSummary = describeProductionVariantCostSummary(null, null);
  const emptyVariant = (status: ProductionVariantView["status"] = "not_created"): ProductionVariantView => ({
    treatment,
    label: productionVariantLabel(treatment),
    description: productionVariantDescription(treatment),
    status,
    finalArtworkJobId: null,
    finalAssetId: null,
    createdAt: null,
    physicalWidthIn: null,
    physicalHeightIn: null,
    pixelWidth: null,
    pixelHeight: null,
    halftone: null,
    attentionReason: null,
    attentionKind: null,
    costSummary: emptyCostSummary,
  });

  const treatmentKey = await resolveVariantTreatmentKey(
    repo,
    snapshot.project.id,
    snapshot,
    treatment,
  );
  if (treatmentKey === null) {
    // Halftone has never been configured for this project, currently or
    // historically -- no job could possibly exist for it. A bare
    // "not created" slot, with nothing guessed about future settings.
    return emptyVariant();
  }

  const state = await graph.finalArtwork.resolveProductionVariantState(
    snapshot.project.id,
    treatmentKey,
  );

  // Display settings for the halftone slot: prefer the job's OWN recorded
  // screen evidence (the durable, per-variant truth) over the brief's
  // current working configuration, which may since have been cleared or
  // changed to a different prospective configuration entirely.
  const assetHalftone =
    treatment === "halftone_dtf" &&
    state.asset?.metadata &&
    typeof state.asset.metadata === "object" &&
    "halftone" in state.asset.metadata &&
    state.asset.metadata.halftone &&
    typeof state.asset.metadata.halftone === "object"
      ? (state.asset.metadata.halftone as { lpi?: unknown; angleDeg?: unknown; dotShape?: unknown })
      : null;
  const halftoneForDisplay =
    treatment !== "halftone_dtf"
      ? null
      : assetHalftone &&
          typeof assetHalftone.lpi === "number" &&
          typeof assetHalftone.angleDeg === "number" &&
          typeof assetHalftone.dotShape === "string"
        ? { lpi: assetHalftone.lpi, angleDeg: assetHalftone.angleDeg, dotShape: assetHalftone.dotShape }
        : snapshot.brief.halftoneSettings
          ? {
              lpi: snapshot.brief.halftoneSettings.lpi,
              angleDeg: snapshot.brief.halftoneSettings.angleDeg,
              dotShape: snapshot.brief.halftoneSettings.dotShape,
            }
          : null;
  const status = describeProductionVariantStatus(
    state.job?.status ?? null,
    state.validationStatus,
  );
  const firstBlockingFailedCheckName = resolveAttentionCheckName(
    state.validationReport,
    state.job?.status ?? null,
    state.job?.lastError ?? null,
  );
  const attentionReason =
    status === "needs_attention" || status === "retryable_failure"
      ? describeVariantAttentionReason(treatment, firstBlockingFailedCheckName)
      : null;
  const attentionKind =
    status === "needs_attention" || status === "retryable_failure"
      ? classifyVariantAttentionKind(firstBlockingFailedCheckName)
      : null;

  const normalization = state.asset?.metadata &&
    typeof state.asset.metadata === "object" &&
    "normalization" in state.asset.metadata
    ? (state.asset.metadata as { normalization?: Record<string, unknown> }).normalization
    : undefined;
  const physicalWidthIn =
    typeof normalization?.intendedWidthIn === "number"
      ? normalization.intendedWidthIn
      : state.job?.productionWidthIn ?? null;
  const physicalHeightIn =
    typeof normalization?.intendedHeightIn === "number" ? normalization.intendedHeightIn : null;

  const providerRequestId =
    state.asset?.metadata &&
    typeof state.asset.metadata === "object" &&
    typeof (state.asset.metadata as { providerRequestId?: unknown }).providerRequestId === "string"
      ? ((state.asset.metadata as { providerRequestId: string }).providerRequestId)
      : null;

  return {
    treatment,
    label: productionVariantLabel(treatment),
    description: productionVariantDescription(treatment),
    status,
    finalArtworkJobId: state.job?.id ?? null,
    // Deliberately only exposed once genuinely `print_ready` -- an asset can
    // exist for a `needs_attention` job too (see `ProductionVariantJobState`'s
    // doc), but it is not a file this variant offers for download.
    finalAssetId: status === "print_ready" ? (state.asset?.id ?? null) : null,
    createdAt: state.job?.createdAt ?? null,
    physicalWidthIn,
    physicalHeightIn,
    pixelWidth: state.asset?.widthPx ?? null,
    pixelHeight: state.asset?.heightPx ?? null,
    halftone: halftoneForDisplay,
    attentionReason,
    attentionKind,
    costSummary: state.job
      ? describeProductionVariantCostSummary(
          { attempts: state.job.attempts, providerKey: state.job.providerKey },
          providerRequestId,
          // Phase 28V: a two-pass reconstruction's own pass-1 request id,
          // when one was durably persisted for this job — counted as a
          // second distinct external provider call.
          [state.intermediateReconstructionProviderRequestId],
        )
      : emptyCostSummary,
  };
}

async function withConceptStatus(
  snapshot: ProjectSnapshot,
): Promise<ApiProjectSnapshot> {
  const conceptStatus = getCapabilityGraph().conceptGeneration.describeConceptStatus(
    snapshot.brief,
    snapshot.artworkVersions,
    snapshot.designBriefVersions,
  );
  const artworkPreparation = await resolveArtworkPreparation(snapshot.project.id);
  return {
    ...snapshot,
    artworkVersions: toCustomerArtworkVersions(snapshot.artworkVersions),
    conceptStatus: toCustomerConceptStatusView(conceptStatus),
    finalization: await customerFinalizationViewForProject(
      snapshot.project.id,
      snapshot.project.status,
      snapshot.brief.requestedProductionOutput,
      currentProductionTreatmentKey(snapshot.brief),
    ),
    printReadySize: await resolvePrintReadySize(snapshot, artworkPreparation),
    artworkPreparation,
    signArtwork: await resolveSignArtworkView(snapshot.project.id),
    acquisition: await resolveAcquisitionView(snapshot),
    payment: await resolvePaymentView(snapshot.project.id),
    productionTreatment: await resolveProductionTreatmentView(
      snapshot,
      artworkPreparation,
    ),
    printReadyPackage: await resolvePrintReadyPackage(snapshot, artworkPreparation),
  };
}

/**
 * Sprint A4. Never allowed to take down a snapshot the customer is waiting
 * on — same advisory-not-a-gate rule as `resolveArtworkPreparation`.
 *
 * Sprint A4 Correction 1: the failure degrades to `"unavailable"`, NOT to
 * `"open"`.
 *
 * Degrading to `"open"` was spend-safe — every real paid-value decision is
 * made independently by the capability that owns the spend, and those all
 * fail closed — but it was product-unsafe in a way that matters: `"open"`
 * renders a UI that offers actions the server is about to refuse. The
 * customer clicks, gets a refusal, and the page they are looking at
 * disagrees with the server that produced it. A neutral "can't continue
 * right now" is the only honest thing to show when the server does not know
 * what this session may do.
 *
 * Sprint A4 Correction C established that row existence is not delivery:
 * the generation worker writes artwork rows several separate writes before
 * the project leaves `generating` and the `concepts_ready` anchor message
 * the concept grid renders against exists, and a `prepared_upload` row is
 * the Existing Artwork customer's OWN pixels rather than a free concept.
 *
 * Sprint A4 Correction C2 moved that question INSIDE the capability, so
 * this function no longer supplies `conceptDelivered` at all. The
 * entitlement belongs to the acquisition SESSION, not to the project being
 * read: a prospect starting a second design in the same browser is refused
 * on project B for something that happened on project A, and project B's
 * snapshot holds no evidence of it. Computing delivery here could only ever
 * answer for the wrong project — which is exactly how the card came to say
 * `continue_locked` while the transcript asked for an email.
 *
 * `generating` stays an input because it genuinely is a property of THIS
 * project ("is this one busy right now"), not of the session.
 */
/**
 * Sprint A5.5. Same advisory-not-a-gate rule as `resolveAcquisitionView`: a
 * commercial view must never take down a snapshot the customer is waiting on.
 *
 * Degrades to `"unavailable"`, NOT to `"payment_required"` and never to
 * `"production_unlocked"`. The direction matters in both ways at once:
 * `payment_required` would render a checkout button whose POST is about to
 * fail for the same reason this read did, and `production_unlocked` would
 * claim an entitlement from an error. `unavailable` is the only honest thing
 * to show when the server cannot establish what this project may do.
 *
 * Every real commercial decision is made independently by
 * `PaymentCapability.createCheckout` and, for the entitlement itself, by
 * `AcquisitionCapability.authorizeFinalization` — both of which fail closed.
 * This function only decides what to draw.
 */
async function resolvePaymentView(
  projectId: string,
): Promise<CustomerPaymentView> {
  try {
    return await getCapabilityGraph().payment.describeForCustomer(projectId);
  } catch {
    return { state: "unavailable", offer: null, checkoutPending: false };
  }
}
async function resolveAcquisitionView(
  snapshot: ProjectSnapshot,
): Promise<CustomerAcquisitionView> {
  try {
    return await getCapabilityGraph().acquisition.describeForCustomer(
      snapshot.project.id,
      { generating: snapshot.project.status === "generating" },
    );
  } catch {
    return {
      state: "unavailable",
      message: ACQUISITION_UNAVAILABLE_MESSAGE,
      emailCaptured: false,
    };
  }
}

/**
 * Never allowed to take down a snapshot the customer is waiting on: a project
 * with no preparation is the overwhelmingly common case, and a lookup failure
 * must degrade to "no uploaded artwork" rather than a failed page load. Same
 * advisory-not-a-gate rule as `resolvePrintReadySize`.
 */
async function resolveArtworkPreparation(
  projectId: string,
): Promise<ArtworkPreparationView | null> {
  try {
    return await getCapabilityGraph().artworkPreparation.getPreparation(projectId);
  } catch {
    return null;
  }
}

/**
 * LIVE PRODUCT BLOCKER #1: the rigid-sign authority's customer-safe view.
 * Deliberately as narrow as `ArtworkPreparationView` is broad — this phase
 * needs only "does a Sign preparation exist" and "what ordered size was
 * confirmed", never inspection, defects, or plan detail (a later,
 * separately-approved Signs phase).
 */
export interface SignArtworkView {
  orderedWidthIn: number | null;
  orderedHeightIn: number | null;
  specConfirmed: boolean;
  /**
   * LIVE PRODUCT BLOCKER #3: the durable, customer-safe planning outcome —
   * reconstructed from the persisted `SignPreparation.plan` on every
   * snapshot build (never cached client-side), so a reload resumes at the
   * plan-review state rather than re-running planning or losing it. `null`
   * until a plan has been durably formulated (`status === "planned"`).
   *
   * A BLOCKED outcome is not separately durable — `sign_preparations` has
   * no schema state for "planning was attempted and blocked", only
   * "planned" vs not (Constitution: no default is a decision, and no
   * migration was authorized for this phase). A reload after a blocked
   * result correctly re-offers the "Check my artwork" action rather than
   * silently re-showing stale blocked copy; re-running planning is safe and
   * deterministic (`planSignRepair` recomputes from the immutable original
   * every time) and will reach the identical blocked result again.
   */
  plan: SignPlanCustomerView | null;
  /**
   * LIVE PRODUCT BLOCKER #4: the durable production-risk authorization
   * state for the CURRENT plan — mirrors the internal operator review's
   * own `SignPlanOperatorReview.authorization` shape exactly (same field
   * names, same semantics, same "matchesCurrentPlan" discipline), just
   * exposed to the customer too. `deriveUploadedArtworkStep` reads
   * `matchesCurrentPlan` to decide whether the customer still needs to
   * act on `sign_plan_review` or has already authorized this exact plan
   * (`sign_plan_authorized`) — a re-plan (different `planKey`) makes a
   * prior authorization stale here exactly like it does internally.
   */
  authorization: {
    authorizedBy: SignPlanAuthorizationActor | null;
    authorizedAt: string | null;
    matchesCurrentPlan: boolean;
  };
  /**
   * SIGNS QR DESTINATION RESOLUTION: 0..N detected-but-undecodable
   * machine-readable regions in the source artwork, each needing an
   * explicit customer decision before Print Ready — empty whenever
   * nothing was detected, or every detected region already has a
   * verified/resolved state. Computed from the SOURCE image only (never
   * the production candidate — this view exists before/independent of
   * production, and stays cheap: the immutable original, not a
   * multi-megapixel reconstructed plate). `null` until a plan exists
   * (Section V: only asked once the customer has requested "Check my
   * artwork" — never before, and never for a source QR that already
   * decodes).
   */
  qrResolutions: SignQrDestinationView[] | null;
}

/**
 * SIGNS QR DESTINATION RESOLUTION: one detected-but-undecodable region's
 * customer-safe state. `regionKey` is opaque to the customer but required
 * verbatim on `.../sign-artwork/qr-destination`
 * `.../sign-artwork/qr-print-as-supplied` — never a raw pixel coordinate,
 * never a decoded payload (there isn't one to leak here by construction).
 */
export interface SignQrDestinationView {
  regionKey: string;
  status: "needs_attention" | "confirmed_destination" | "print_as_supplied";
}

/**
 * Same advisory-not-a-gate rule as `resolveArtworkPreparation`: a lookup
 * failure degrades to "no sign artwork" rather than taking down the
 * snapshot the customer is waiting on. QR detection specifically degrades
 * to `qrResolutions: null` on any failure (decode error, asset unreadable)
 * — never blocks the rest of the view, never guessed.
 */
async function resolveSignArtworkView(
  projectId: string,
): Promise<SignArtworkView | null> {
  try {
    const preparation =
      await getCapabilityGraph().signPreparation.getSignPreparation(projectId);
    if (!preparation) return null;
    return {
      orderedWidthIn: preparation.orderedWidthIn,
      orderedHeightIn: preparation.orderedHeightIn,
      specConfirmed: preparation.specConfirmedAt !== null,
      plan: durableSignPlanView(preparation),
      authorization: {
        authorizedBy: preparation.authorizedBy,
        authorizedAt: preparation.authorizedAt,
        matchesCurrentPlan:
          preparation.authorizedPlanKey !== null &&
          preparation.authorizedPlanKey === preparation.planKey,
      },
      qrResolutions: preparation.plan ? await resolveSignQrDestinationViews(preparation) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Decodes the immutable source once (Section V: SOURCE only, never the
 * candidate — this stays cheap and runs on every snapshot fetch, unlike
 * the internal operator's own candidate-aware evidence). Deliberately its
 * own try/catch, separate from the outer one, so a QR-decode failure
 * degrades to `null` without discarding the rest of the (already
 * successfully resolved) sign artwork view.
 */
async function resolveSignQrDestinationViews(
  preparation: SignPreparation,
): Promise<SignQrDestinationView[] | null> {
  try {
    const downloaded = await getCapabilityGraph().assets.downloadAssetBytes(preparation.originalAssetId);
    if (!downloaded) return null;
    const png = PNG.sync.read(downloaded.bytes);
    const source = { width: png.width, height: png.height, data: Buffer.from(png.data) };

    if (decodeQrCodes(source).length > 0) return []; // Already decodable — never asked for a destination (Section V).
    const undecoded = scanForQrFinderPatterns(source);
    if (undecoded.length === 0) return [];

    const resolutions = Array.isArray(preparation.qrResolutions) ? preparation.qrResolutions : [];
    return undecoded.map((region) => {
      const regionKey = deriveRegionKey(region.bounds);
      const record = resolutions.find(
        (r) => r.regionKey === regionKey && r.sourceAssetId === preparation.originalAssetId,
      ) as { state?: string } | undefined;
      const status: SignQrDestinationView["status"] =
        record?.state === "confirmed_destination"
          ? "confirmed_destination"
          : record?.state === "print_as_supplied"
            ? "print_as_supplied"
            : "needs_attention";
      return { regionKey, status };
    });
  } catch {
    return null;
  }
}

/**
 * LIVE PRODUCT BLOCKER #3: reconstructs the customer plan view from the
 * DURABLE `SignPreparation` row alone — the source of truth on every
 * reload, never a value trusted from the client. `status === "planned"` is
 * the only durable signal a plan exists (see `SignArtworkView.plan`'s own
 * doc for why a blocked outcome isn't separately durable this phase).
 */
function durableSignPlanView(preparation: {
  status: string;
  plan: Record<string, unknown> | null;
  orderedWidthIn: number | null;
  orderedHeightIn: number | null;
}): SignPlanCustomerView | null {
  if (preparation.status !== "planned" || !preparation.plan) return null;
  // Narrowed here, same discipline as `preparation.analysis as unknown as
  // ArtworkAnalysis` elsewhere: `plan` is untyped jsonb at the repository
  // boundary, narrowed to its real shape only where a capability already
  // guarantees it (planSignRepair only ever persists a genuine SignRepairPlan
  // under `status: "planned"`).
  const plan = preparation.plan as unknown as SignRepairPlan;
  return describeSignPlanForCustomer({
    orderedWidthIn: preparation.orderedWidthIn ?? plan.orderedWidthIn,
    orderedHeightIn: preparation.orderedHeightIn ?? plan.orderedHeightIn,
    artworkWidthPx: plan.sourceWidthPx,
    artworkHeightPx: plan.sourceHeightPx,
    defectCodes: plan.defects as readonly SignDefectCode[],
    plan,
  });
}

/**
 * Live Acceptance Cleanup (Issue 5). Height comes from the SELECTED
 * concept's own pixel aspect ratio through the same
 * `resolveWidthConstrainedSizing` the production transform uses, so the
 * size shown before finalizing and the plate produced afterwards are the
 * same arithmetic rather than two independent estimates. When the artwork's
 * dimensions aren't resolvable, height is reported as unknown rather than
 * guessed.
 *
 * Skipped entirely once artwork is print-ready — the delivery card shows the
 * plate's real measured size at that point, which is strictly better than a
 * pre-finalization projection.
 */
async function resolvePrintReadySize(
  snapshot: ProjectSnapshot,
  preparation: ArtworkPreparationView | null,
): Promise<PrintReadySizeView | null> {
  // Existing Artwork → Print Ready Phase 2: an upload project has no
  // "selected concept" and never will — its production artwork is the
  // prepared upload the customer approved. Height comes from that artwork's
  // OWN visible bounds rather than its canvas, because the production
  // transform trims to those bounds before sizing; quoting the canvas would
  // promise a height the finished plate will not have.
  //
  // Unlike the create_new path below, this is NOT skipped once the artwork is
  // print-ready. A create_new customer who wants a different size reopens the
  // creative loop they are still in ("Make Another Change"); an upload
  // customer has no creative loop, so this control is their only route to a
  // different size, and hiding it would strand them.
  if (preparation?.approved) {
    return describePrintReadySize({
      printPlacement: snapshot.brief.printPlacement,
      intendedPrintWidthIn: snapshot.brief.intendedPrintWidthIn,
      artworkWidthPx: preparation.visibleArtworkWidthPx,
      artworkHeightPx: preparation.visibleArtworkHeightPx,
      ...productionSizeAuthorityOf(snapshot),
    });
  }

  if (snapshot.project.status === "print_ready") return null;

  const selectedId = snapshot.project.selectedArtworkVersionId;
  if (!selectedId) return null;

  const selected = snapshot.artworkVersions.find(
    (version) => version.id === selectedId,
  );
  if (!selected) return null;

  let artworkWidthPx: number | null = null;
  let artworkHeightPx: number | null = null;
  if (selected.primaryAssetId) {
    try {
      const assets = await getCapabilityGraph().assets.listAssets(
        snapshot.project.id,
      );
      const asset = assets.find((item) => item.id === selected.primaryAssetId);
      artworkWidthPx = asset?.widthPx ?? null;
      artworkHeightPx = asset?.heightPx ?? null;
    } catch {
      // Size is advisory copy, never a gate — an asset lookup failure must
      // not take down the whole snapshot the customer is waiting on.
      artworkWidthPx = null;
      artworkHeightPx = null;
    }
  }

  return describePrintReadySize({
    printPlacement: snapshot.brief.printPlacement,
    intendedPrintWidthIn: snapshot.brief.intendedPrintWidthIn,
    artworkWidthPx,
    artworkHeightPx,
    ...productionSizeAuthorityOf(snapshot),
  });
}

/**
 * Sprint A4: `acquisitionSessionId` binds the new project to the session
 * that created it, in the same insert that creates it. Every later
 * paid-value gate resolves authority from that binding rather than from a
 * cookie, which is what makes a direct API call no more powerful than the
 * UI. Omitted only by internal callers and tests, which produce a
 * legacy-unbound (grandfathered) project.
 */
export async function startConversation(
  acquisitionSessionId: string | null = null,
): Promise<ApiProjectSnapshot> {
  return await withConceptStatus(
    await getCapabilityGraph().conversation.start(acquisitionSessionId),
  );
}

/**
 * Sprint A4: the customer's email, captured so they can keep working on
 * their design. Returns the refreshed snapshot on success so the caller
 * renders state derived by the same path as every other read.
 *
 * Grants nothing. Capturing an address does not restore a spent free
 * concept, does not authorize generation, and does not unlock finalization
 * (Goal 14) — those remain the business of the capabilities that own the
 * spend. It is also not marketing consent, and no claim of an account is
 * made anywhere in this path.
 */
export async function captureAcquisitionEmail(
  projectId: string,
  rawEmail: unknown,
): Promise<
  | { ok: true; snapshot: ApiProjectSnapshot }
  | { ok: false; message: string }
> {
  const result: EmailCaptureResult =
    await getCapabilityGraph().acquisition.captureEmail(projectId, rawEmail);
  if (!result.ok) return result;

  const snapshot = await getConversation(projectId);
  if (!snapshot) return { ok: false, message: "Project not found" };
  return { ok: true, snapshot };
}

/**
 * Loading a project also repairs a generation request that a previous turn
 * left half-applied — an approved brief or a pending revision with no
 * `GenerationJob` behind it. See
 * `ConversationCapability.recoverInterruptedGenerationRequest` for why
 * those states are otherwise terminal, and why completing them honors the
 * customer's existing instruction rather than generating on the platform's
 * own initiative. Awaited, not fired and forgotten, so the snapshot the
 * customer receives already reflects the recovered work instead of a stale
 * "approved but idle".
 */
export async function getConversation(
  projectId: string,
): Promise<ApiProjectSnapshot | null> {
  const snapshot =
    await getCapabilityGraph().conversation.recoverInterruptedGenerationRequest(
      projectId,
    );
  if (!snapshot) return null;
  const apiSnapshot = await withConceptStatus(snapshot);
  if (apiSnapshot.project.status === "generating") {
    // A job this call just recovered is `queued` with zero attempts, which
    // is exactly what the existing stranded-job trigger already picks up in
    // interactive dev — no second trigger needed here.
    void maybeRecoverStrandedLocalGenerationJobs(projectId, "project_reload");
  }
  if (apiSnapshot.project.status === "finalizing") {
    void maybeRecoverStrandedLocalFinalArtworkJobs(projectId, "project_reload");
  }
  return apiSnapshot;
}

export async function handleUserMessage(
  projectId: string,
  content: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.handleUserMessage(
    projectId,
    content,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "conversation_message");
  return apiSnapshot;
}

/**
 * Correction A: the "Create New Artwork" workflow choice.
 *
 * Deliberately NOT routed through `handleUserMessage`. A workflow choice is
 * control state, and expressing it as a synthetic customer sentence put
 * words in the customer's mouth in the transcript and then carried them
 * into the Design Brief and the generation prompt.
 *
 * No local worker kick: choosing a workflow enqueues nothing and can never
 * make generation eligible.
 */
export async function beginCreateNewWorkflow(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.beginCreateNewWorkflow(projectId),
  );
}

export async function selectConcept(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.selectConcept(
    projectId,
    artworkVersionId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Live Acceptance Corrective Pass (Section 2): the customer's explicit "no
 * more changes, use this design" confirmation — the [Use This Design]
 * action. Distinct from, and strictly stronger than, `selectConcept`;
 * `FinalArtworkCapability.requestFinalArtwork` refuses to finalize without
 * it, independent of revision-pending state.
 */
export async function confirmSelectedDirection(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.confirmSelectedDirection(
    projectId,
    artworkVersionId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Sprint 2M Phase 2B: the customer's explicit "this is my final direction —
 * prepare it for production" action. Idempotent — see `FinalArtworkCapability`.
 * Interactive `next dev` kicks the in-process final-artwork scheduler after a
 * durable claimable enqueue (mirrors generation's local trigger).
 */
export async function approveFinalDirection(
  projectId: string,
  artworkVersionId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.approveFinalDirection(
    projectId,
    artworkVersionId,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalFinalArtworkWorker(
    projectId,
    apiSnapshot,
    "approve_final_direction",
  );
  return apiSnapshot;
}

/**
 * Sprint 2D: Approve / Edit / Continue in response to a presented Design
 * Summary. Approval is idempotent and is the only path that can trigger
 * concept generation.
 */
export async function submitDesignBriefDecision(
  projectId: string,
  action: DesignBriefDecisionAction,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.submitDesignBriefDecision(
    projectId,
    action,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  if (action === "approve") {
    maybeKickLocalGenerationWorker(projectId, apiSnapshot, "approve_brief");
  }
  return apiSnapshot;
}

/**
 * Live Acceptance Cleanup (Issue 2): explicit "Change Selection" action.
 * Server-owned — never a client-side visual reset. See
 * `ConversationCapability.unselectConcept`.
 */
export async function unselectConcept(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.unselectConcept(projectId),
  );
}

/**
 * Live Acceptance Cleanup (Issue 3): explicit "Show Me 3 New Concepts"
 * action — a fresh batch of three directions from the same approved brief.
 */
export async function exploreNewConceptBatch(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot =
    await getCapabilityGraph().conversation.exploreNewConceptBatch(projectId);
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "regenerate_concepts");
  return apiSnapshot;
}

/**
 * Live Acceptance Cleanup (Issue 5): explicit "Change Size" action. A
 * production-specification change only — never generation, never a creative
 * revision, never a provider call.
 */
export async function setProductionPrintWidth(
  projectId: string,
  requestedWidthIn: number | null,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.setProductionPrintWidth(
      projectId,
      requestedWidthIn,
    ),
  );
}

/**
 * Print'em All Phase 1: "Use recommended size" — confirms the recommended
 * production box for this project's placement and garment size class.
 */
export async function confirmRecommendedProductionSize(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.confirmRecommendedProductionSize(
      projectId,
    ),
  );
}

/**
 * Print'em All Phase 2: the operator's PRODUCTION TREATMENT choice.
 *
 * Internal-operator only; the entitlement check is inside the capability, on
 * the write, never here and never in the route.
 */
export async function selectProductionTreatment(
  projectId: string,
  selection: ProductionTreatmentRequest,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.selectProductionTreatment(
      projectId,
      selection,
    ),
  );
}

/**
 * Print'em All Phase 1: records the garment sizing context the print box is
 * recommended for. Withdraws any existing size confirmation — see
 * `DesignBriefCapability.setGarmentSizeClass`.
 */
export async function setGarmentSizeClass(
  projectId: string,
  garmentSizeClass: GarmentSizeClass | null,
): Promise<ApiProjectSnapshot> {
  return withConceptStatus(
    await getCapabilityGraph().conversation.setGarmentSizeClass(
      projectId,
      garmentSizeClass,
    ),
  );
}

/**
 * Print'em All Phase 1: the production-size authority fields, in one place.
 *
 * Spread into every `describePrintReadySize` call rather than listed at each
 * one, so a new call site cannot quietly omit the confirmation and render a
 * size that looks approved because it looks like a number.
 */
function productionSizeAuthorityOf(snapshot: ProjectSnapshot) {
  return {
    garmentSizeClass: snapshot.brief.garmentSizeClass,
    productionSizeConfirmedAt: snapshot.brief.productionSizeConfirmedAt,
    productionSizeConfirmedWidthIn: snapshot.brief.productionSizeConfirmedWidthIn,
    productionSizeConfirmedMaxHeightIn:
      snapshot.brief.productionSizeConfirmedMaxHeightIn,
  };
}

/** Sprint 2G Part 3: explicit action behind the persistent "Generate Updated Concepts" control. */
export async function regenerateConcepts(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.regenerateConcepts(
    projectId,
  );
  const apiSnapshot = await withConceptStatus(snapshot);
  maybeKickLocalGenerationWorker(projectId, apiSnapshot, "regenerate_concepts");
  return apiSnapshot;
}

/** Sprint 2G Part 3: explicit action behind an "Undo" control. */
export async function undoLastChange(
  projectId: string,
): Promise<ApiProjectSnapshot> {
  const snapshot = await getCapabilityGraph().conversation.undoLastChange(
    projectId,
  );
  return withConceptStatus(snapshot);
}

/**
 * Interactive `next dev` only: after enqueue persistence, kick the in-process
 * scheduler so local Approve/Create Concepts does not wait on a manual
 * `POST /api/worker/generation`. Production and automated tests no-op — see
 * `local-generation-trigger-policy.ts`. Never throws to the customer request.
 */
function maybeKickLocalGenerationWorker(
  projectId: string,
  snapshot: ApiProjectSnapshot,
  reason: LocalGenerationTriggerReason,
): void {
  if (snapshot.project.status !== "generating") return;
  maybeTriggerLocalGenerationWorker({ projectId, reason });
}

/**
 * Interactive `next dev` only: after FinalArtworkJob enqueue persistence,
 * kick the in-process final-artwork scheduler so local Prepare Print-Ready
 * does not wait on a manual `POST /api/worker/final-artwork`. Production
 * and automated tests no-op — shared policy in
 * `local-generation-trigger-policy.ts`. Never throws to the customer request.
 */
function maybeKickLocalFinalArtworkWorker(
  projectId: string,
  snapshot: ApiProjectSnapshot,
  reason: LocalFinalArtworkTriggerReason,
): void {
  if (snapshot.project.status !== "finalizing") return;
  maybeTriggerLocalFinalArtworkWorker({ projectId, reason });
}

/**
 * Sprint 2H Part 2B: provider-neutral generation status, safe for the
 * conversation to poll every few seconds — no job id, no provider name, no
 * queue detail. Production and automated tests are purely read-only: a
 * status read and nothing else. They never recover abandoned jobs, never
 * claim work, and never run generation. Interactive `next dev` only may
 * kick a stranded `queued`/`attempts=0` job (missed post-enqueue trigger
 * or stale HMR) via `maybeRecoverStrandedLocalGenerationJobs`. Polling
 * still never revives a running/failed job and never calls a provider
 * itself.
 */
export type GenerationStatus = "idle" | "generating" | "ready" | "failed";

export interface GenerationStatusView {
  status: GenerationStatus;
}

function toGenerationStatusView(status: ProjectStatus): GenerationStatusView {
  if (status === "generating") return { status: "generating" };
  if (status === "concepts_ready") return { status: "ready" };
  if (status === "failed") return { status: "failed" };
  return { status: "idle" };
}

export async function getGenerationStatus(
  projectId: string,
): Promise<GenerationStatusView | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  if (snapshot.project.status === "generating") {
    void maybeRecoverStrandedLocalGenerationJobs(projectId, "status_poll");
  }
  return toGenerationStatusView(snapshot.project.status);
}

/**
 * Customer-safe finalization status — the finalization counterpart of
 * `getGenerationStatus`. Same sanitization choke point as the snapshot's
 * `finalization` view (`toCustomerFinalizationView`): never a job id,
 * provider name, queue detail, or storage key. Production and automated
 * tests are purely read-only. Interactive `next dev` only may kick a
 * stranded `queued`/`attempts=0` FinalArtworkJob (missed post-enqueue
 * trigger or stale HMR) via `maybeRecoverStrandedLocalFinalArtworkJobs`.
 * Polling still never revives a failed/cancelled/completed job and never
 * calls a provider itself.
 */
export async function getFinalizationStatus(
  projectId: string,
): Promise<CustomerFinalizationView | null> {
  const snapshot = await getCapabilityGraph().conversation.get(projectId);
  if (!snapshot) return null;
  if (snapshot.project.status === "finalizing") {
    void maybeRecoverStrandedLocalFinalArtworkJobs(projectId, "status_poll");
  }
  return customerFinalizationViewForProject(
    projectId,
    snapshot.project.status,
    snapshot.brief.requestedProductionOutput,
    currentProductionTreatmentKey(snapshot.brief),
  );
}

export interface ConceptImageView {
  /** Short-lived signed URL from `AssetCapability.getSignedUrl` — never a raw object key. */
  url: string;
}

/**
 * Sprint 2K Phase 1: the only path from a browser-visible `artworkVersionId`
 * to a real, renderable image. Looks the concept up in the internal
 * (unsanitized) snapshot purely to find its `primaryAssetId`, then asks
 * `AssetCapability` for a fresh signed URL — the asset id itself never
 * leaves the server. Returns `null` whenever the project, the concept, or a
 * generated image doesn't exist, so callers can render a uniform 404
 * without leaking which case applied.
 */
export async function getConceptImageUrl(
  projectId: string,
  artworkVersionId: string,
): Promise<ConceptImageView | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot) return null;

  const artwork = snapshot.artworkVersions.find(
    (version) => version.id === artworkVersionId && version.projectId === projectId,
  );
  if (!artwork || !artwork.primaryAssetId) return null;

  const url = await graph.assets.getSignedUrl(artwork.primaryAssetId);
  return url ? { url } : null;
}

export interface ProductionArtworkView {
  /** Short-lived signed URL — never a raw object key, asset id, or job/approval id. */
  url: string;
  /** Customer-safe download basename suggestion (e.g. `1988-toyota-mr2-print-ready.png`). */
  filename: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  /** Plain-language print placement, e.g. "Full Front". */
  placementLabel: string | null;
  /** Customer-facing design label (required wording, else product summary). */
  designLabel: string | null;
  /**
   * Live Acceptance Cleanup (Issue 5): the plate's ACTUAL physical print
   * size and resolution, read from the production normalization record
   * persisted with the asset — never the placement default, and never
   * re-derived here. A customer who chose 12" must see 12", not a stale 10.5".
   * `null` for a production asset created before normalization recorded it.
   */
  widthIn: number | null;
  heightIn: number | null;
  dpi: number | null;
}

/**
 * Sprint 2M Phase 2C (Goal 14) + delivery-mode: the secure read boundary for
 * print-ready production artwork preview/download. Returns a fresh,
 * short-lived signed URL plus customer-safe metadata for the project's
 * current print-ready production PNG, or `null` on any miss (project not
 * found, not print-ready yet, or no production asset resolvable) — every
 * miss is deliberately indistinguishable. Never exposes asset/job/provider
 * ids or storage paths. Only ever exposes a URL once
 * `PrintProject.status === "print_ready"`.
 */
export async function getProductionArtworkUrl(
  projectId: string,
): Promise<ProductionArtworkView | null> {
  const resolved = await resolveCurrentProductionArtwork(projectId);
  if (!resolved) return null;

  const url = await getCapabilityGraph().assets.getSignedUrl(resolved.assetId);
  if (!url) return null;

  return {
    url,
    filename: resolved.filename,
    mimeType: resolved.mimeType,
    widthPx: resolved.widthPx,
    heightPx: resolved.heightPx,
    transparent: resolved.transparent,
    placementLabel: resolved.placementLabel,
    designLabel: resolved.designLabel,
    widthIn: resolved.widthIn,
    heightIn: resolved.heightIn,
    dpi: resolved.dpi,
  };
}

/**
 * Streams the current print-ready production PNG for a forced download with
 * a customer-safe Content-Disposition filename. Same authorization gates as
 * `getProductionArtworkUrl` — never a storage path or internal id.
 */
export async function getProductionArtworkDownload(
  projectId: string,
): Promise<{
  bytes: Buffer;
  contentType: string;
  filename: string;
} | null> {
  const resolved = await resolveCurrentProductionArtwork(projectId);
  if (!resolved) return null;

  const downloaded = await getCapabilityGraph().assets.downloadAssetBytes(
    resolved.assetId,
  );
  if (!downloaded) return null;

  return {
    bytes: downloaded.bytes,
    contentType: downloaded.contentType || resolved.mimeType,
    filename: resolved.filename,
  };
}

async function resolveCurrentProductionArtwork(projectId: string): Promise<{
  assetId: string;
  filename: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  placementLabel: string | null;
  designLabel: string | null;
  widthIn: number | null;
  heightIn: number | null;
  dpi: number | null;
} | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot) return null;

  // Sprint A2 Correction 3 (Goal 5 / Goal 10): the ONLY gate is now whether a
  // completed job satisfies the CURRENT request — current authority, matching
  // bound intent, real asset, `ready` validation for that asset.
  //
  // `project.status === "print_ready"` used to guard this, and it is the
  // wrong question in both directions. It said yes to a historical PNG when
  // the customer had since asked for separations (the plate was still on
  // file, so the status still read print_ready) — handing over an artifact as
  // though it answered a request it does not. And it said no to a perfectly
  // valid, current plate whose project status was left stale at
  // `finalization_required` by an unsupported job that ran in between.
  // `getCurrentProductionAssetId` is strictly stronger than the status check
  // ever was, so nothing is loosened by dropping it.
  const assetId = await graph.finalArtwork.getCurrentProductionAssetId(projectId);
  if (!assetId) return null;

  const assets = await graph.assets.listAssets(projectId);
  const asset = assets.find((item) => item.id === assetId);
  if (!asset || asset.productionRole !== "production_png") return null;

  const placementRaw = printPlacementLabel(snapshot.brief.printPlacement);
  const placementLabel = placementRaw
    ? placementRaw.replace(/\b\w/g, (char) => char.toUpperCase())
    : null;
  const designLabel =
    snapshot.brief.exactText?.trim() ||
    snapshot.brief.productSummary?.trim() ||
    null;
  const mimeType = asset.contentType ?? "image/png";
  // The plate's own recorded production geometry (Print-Ready Normalization
  // Phase 1 writes it alongside the bytes) — the only honest source for
  // "what size is this file", since it is what the transform actually
  // produced rather than what policy would have asked for today.
  const normalization = asset.metadata?.normalization as
    | Record<string, unknown>
    | undefined;

  // Existing Artwork → Print Ready Phase 2: for an upload project, the
  // customer's own filename is the name they will recognize — see
  // `buildPrintReadyFilename`'s precedence. Resolved through the same
  // never-take-down-the-request helper as everywhere else: a filename is
  // presentation, and a lookup failure must degrade to the brief-derived
  // name rather than fail the download.
  const preparation = await resolveArtworkPreparation(projectId);

  return {
    assetId,
    widthIn: readFiniteNumber(normalization?.intendedWidthIn),
    heightIn: readFiniteNumber(normalization?.intendedHeightIn),
    dpi: readFiniteNumber(normalization?.targetPpi),
    filename: buildPrintReadyFilename({
      uploadedFilename: preparation?.originalFilename ?? null,
      exactText: snapshot.brief.exactText,
      productSummary: snapshot.brief.productSummary,
      mimeType,
    }),
    mimeType,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    transparent: asset.hasTransparency,
    placementLabel,
    designLabel,
  };
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Print'em All Phase 3 (Goal 16 — DOWNLOAD IDENTITY): the treatment-scoped
 * counterpart of `getProductionArtworkDownload`.
 *
 * THE INVARIANT THIS EXISTS TO GUARANTEE: a customer who asks for the
 * Standard Raster file always receives the Standard Raster asset, and a
 * customer who asks for the DTF Halftone file always receives the DTF
 * Halftone asset — regardless of which treatment the operator currently has
 * SELECTED in the controls. `getProductionArtworkDownload` (unscoped) reads
 * "the current deliverable", which is exactly the single project-level
 * pointer Phase 27O's audit identified as unable to represent two
 * independently-completed variants; this resolves a NAMED variant instead,
 * via `resolveVariantTreatmentKey` + `resolveProductionVariantState` — the
 * same identity the package view itself is built from, so the two can never
 * disagree about which bytes a variant means.
 *
 * Returns `null` for every miss uniformly (no project, no preparation, no
 * job for this exact variant, or a job that has not reached `print_ready`)
 * — a customer must never be able to distinguish "this variant doesn't
 * exist" from "it exists but isn't ready" from the response shape alone.
 */
export async function getProductionArtworkDownloadForVariant(
  projectId: string,
  treatment: ProductionVariantTreatment,
): Promise<{
  bytes: Buffer;
  contentType: string;
  filename: string;
} | null> {
  const graph = getCapabilityGraph();
  const snapshot = await graph.conversation.get(projectId);
  if (!snapshot) return null;

  const treatmentKey = await resolveVariantTreatmentKey(
    getProjectRepository(),
    projectId,
    snapshot,
    treatment,
  );
  if (treatmentKey === null) return null;

  const state = await graph.finalArtwork.resolveProductionVariantState(
    projectId,
    treatmentKey,
  );
  const status = describeProductionVariantStatus(
    state.job?.status ?? null,
    state.validationStatus,
  );
  if (status !== "print_ready" || !state.asset) return null;

  const downloaded = await graph.assets.downloadAssetBytes(state.asset.id);
  if (!downloaded) return null;

  const mimeType = state.asset.contentType ?? "image/png";
  const preparation = await resolveArtworkPreparation(projectId);
  const baseFilename = buildPrintReadyFilename({
    uploadedFilename: preparation?.originalFilename ?? null,
    exactText: snapshot.brief.exactText,
    productSummary: snapshot.brief.productSummary,
    mimeType,
  });
  // Two variants sharing one base name would otherwise silently overwrite
  // each other on a customer's own downloads folder — the one filename-level
  // consequence of "two files now exist" that this layer must account for.
  const suffix = treatment === "standard_raster" ? "-standard-raster" : "-dtf-halftone";
  const filename = baseFilename.replace(/(\.[^./\\]+)?$/, (ext) => `${suffix}${ext}`);

  return {
    bytes: downloaded.bytes,
    contentType: downloaded.contentType || mimeType,
    filename,
  };
}
