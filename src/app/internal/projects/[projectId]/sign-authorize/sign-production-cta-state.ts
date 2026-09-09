import type {
  SignMachineReadableContentSummary,
  SignPhysicalResolutionMetadataSummary,
  SignPlanOperatorProductionStatus,
} from "@/capabilities/sign-preparation";

/**
 * FIX AUTHORIZED SIGN PRODUCTION WORKSPACE CTA: pure extraction of
 * `SignProductionAction`'s "what to show" decision, so it can be tested
 * without a mounted Next.js App Router (`SignProductionAction` calls
 * `useRouter()`, which throws "invariant expected app router to be
 * mounted" under this repo's plain `renderToString` test tooling — no
 * `next/navigation` mock exists anywhere in this codebase, and inventing
 * one for a single component would be a new testing pattern, not a bounded
 * fix). This is a byte-for-byte behavior-preserving extraction of the
 * SAME branches `SignProductionAction` already had inline — same
 * precedence, same conditions, same labels — moved out so it is directly,
 * cheaply testable, exactly like `uploaded-artwork-flow.ts` and
 * `sign-production-bridge.ts` already pull decisions out of components for
 * the identical reason.
 *
 * Investigation note (the actual finding for this task): the real project
 * this task was filed against (`0858d192-e74e-40b5-8532-a91bc4bcdf8e`) was
 * reported as "misclassified" — expected to show "Prepare artwork", showed
 * "Try again" instead. Read-only inspection of its real, durable
 * `FinalArtworkJob` found a genuine `status: "failed"` job bound to the
 * CURRENT `planKey` (`lastError: "produceSignReconstruction failed after
 * 11945ms: The production reconstruction provider could not be reached
 * (TypeError: UND_ERR_CONNECT_TIMEOUT)."`, `providerKey: null` — the
 * request never reached the provider, so no paid dispatch occurred). "Try
 * again" is the objectively correct action(kind: "action") result for that
 * state — see state 5 below — not a defect in this derivation. No
 * behavior changed as a result of this task; this module exists to LOCK IN
 * the already-correct mapping with real, isolated tests, matching the
 * regression coverage this task's own state model (states 1–6) asked for.
 */
export type SignProductionCtaState =
  /** State 4 (COMPLETED VALID CANDIDATE, print-ready case): download, not an execution action. */
  | { kind: "print_ready" }
  /** State 3 (ACTIVE JOB): work is in flight right now — no execution button at all, prevents a duplicate dispatch by construction. */
  | { kind: "in_flight" }
  /**
   * Signs QR Visual Revision Acceptance: every TECHNICAL check passes, but
   * this exact candidate's visible pixels came from a QR replacement that
   * no human has approved yet. No execution button here at all — nothing
   * about re-running the identical deterministic composition would change
   * whether a human has looked at the result; the dedicated visual-
   * acceptance panel below carries the one real next action ("Approve
   * revised artwork"). Checked ahead of the ordinary `needs_qr_resolution`
   * /`needs_physical_resolution_repair`/`action` branches below — by
   * construction it can never overlap with either of the first two (both
   * require a FAILING technical check; this state requires every technical
   * check to already pass) — but its own precedence keeps this module's
   * "what wins" ordering exhaustive and explicit rather than incidental.
   */
  | { kind: "needs_visual_acceptance"; assetId: string }
  /**
   * Fix QR Review UX Phase (real Get Hibachi acceptance incident: a
   * candidate whose physical production checks all PASS, blocked only by
   * unresolved machine-readable content, still showed a large "Try again"
   * production-execution CTA — misleading, since re-running the identical
   * deterministic composition against the identical source changes
   * nothing about an unchecked/unresolved QR). No execution button here
   * at all: the QR resolution panel below (`SignQrPreservationPanel`)
   * already carries the correct next actions ("Fix QR code"/"Print as
   * supplied"). See `isMachineReadableBlocking`'s own doc for exactly
   * which machine-readable states this covers.
   */
  | { kind: "needs_qr_resolution" }
  /**
   * Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair
   * Phase (real Get Hibachi production incident): a candidate blocked ONLY
   * by disagreeing/missing physical-resolution metadata is a metadata
   * repair, never an execution retry — re-running the identical
   * deterministic composition against the identical source reproduces
   * pixels that already agree with the ordered size; the density TAG is
   * what needs correcting. No execution button here at all: the physical-
   * resolution repair panel below (`SignPhysicalResolutionRepairPanel`)
   * carries the correct next action ("Fix print size metadata"). Checked
   * AFTER `needs_qr_resolution` — see `resolveSignProductionCtaState`'s own
   * precedence note.
   */
  | { kind: "needs_physical_resolution_repair" }
  /**
   * States 2, 5, and 6 (COMPLETED-BUT-BLOCKED) all render the SAME
   * execution button, differing only in label and whether the
   * needs-attention notice shows above it:
   *
   *   - `label: "prepare_artwork"` — state 2 (authorized, executable, no
   *     job at all yet — `jobStatus === null`). Never "Try again" for a
   *     project that has genuinely never been executed.
   *   - `label: "try_again"` with `needsAttentionNotice: false` — state 5,
   *     a genuinely FAILED job for the current plan (`production.failed`).
   *     This is the real project's actual state.
   *   - `label: "try_again"` with `needsAttentionNotice: true` — state 6,
   *     a COMPLETED job whose candidate was not print-ready
   *     (`production.needsAttention`, blocked-candidate review). This is
   *     the EXISTING, protected behavior for the Wand/correction project
   *     `cc6cfc4b-c0db-4889-ad77-58c5f5520b9a` — deliberately left
   *     unchanged by this task (its own regression requirement). Never
   *     reached when `isMachineReadableBlocking` is true — that case
   *     returns `needs_qr_resolution` instead, above.
   */
  | { kind: "action"; label: "prepare_artwork" | "try_again"; needsAttentionNotice: boolean };

/**
 * Fix QR Review UX Phase: true iff the machine-readable evidence itself
 * represents an UNRESOLVED production issue an operator must act on
 * directly (through the QR panel's own "Fix QR code"/"Restore QR code"/
 * "Print as supplied" actions) — never something an execution retry could
 * ever change, since re-running the identical deterministic composition
 * against the identical immutable source reproduces identical QR evidence
 * every time. `pass`/`accepted_as_supplied`/`not_applicable` are resolved
 * or non-blocking states and never reach this branch (`needsAttention`
 * itself already excludes them — see `resolveSignProductionStatus`'s own
 * `printReady` derivation). `null` (no machine-readable evidence at all,
 * e.g. a genuinely failed job with no candidate) correctly returns
 * `false` — this never interferes with the CASE B retry regression.
 */
function isMachineReadableBlocking(machineReadableContent: SignMachineReadableContentSummary | null): boolean {
  if (!machineReadableContent) return false;
  const result = machineReadableContent.overall;
  return result === "review_required" || result === "fail" || result === "hard_fail";
}

/**
 * Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair
 * Phase: true iff the `physical_resolution_metadata` check ITSELF was
 * evaluated and genuinely disagrees (`"fail"`) — mirrors
 * `isMachineReadableBlocking`'s own `null`-is-never-blocking discipline
 * exactly (Section CASE C protection's identical reasoning): `null` means
 * no evidence for THIS check at all — either never evaluated, or (the real
 * historical Get Hibachi shape) a validation persisted before this check
 * existed — and must never be assumed to mean "blocking", or an
 * `needsAttention` candidate blocked for a genuinely UNRELATED reason would
 * be misclassified into this branch instead of the ordinary `try_again`.
 * The real historical shape is instead surfaced by
 * `SignPhysicalResolutionRepairPanel`, rendered unconditionally alongside
 * the QR panel whenever a job has completed — independent of this CTA,
 * exactly like that panel already is.
 */
function isPhysicalResolutionMetadataBlocking(
  physicalResolutionMetadata: SignPhysicalResolutionMetadataSummary | null,
): boolean {
  return physicalResolutionMetadata?.status === "fail";
}

/**
 * "Preparing Artwork" Never Spins Forever Phase (real production blocker:
 * a genuinely-queued `FinalArtworkJob` can sit unclaimed for an extended
 * period whenever nothing has actually run the independent worker layer
 * yet — see `docs/deployment/final-artwork-worker.md`'s "scheduled
 * endpoint" topology; the web process is never itself the worker in
 * production). `SignProductionAction`'s own polling (`router.refresh()`
 * every `SIGN_PREPARATION_POLL_INTERVAL_MS` while `cta.kind === "in_flight"`)
 * must never continue unboundedly: once a plan has been in flight for
 * `SIGN_PREPARATION_POLL_TIMEOUT_MS` with no observed transition out of
 * it, the UI stops silently spinning and says so plainly instead.
 *
 * `SIGN_PREPARATION_POLL_TIMEOUT_MS` is generous on purpose — the
 * deterministic (no-provider) path this real case exercises completes in
 * low single-digit seconds (empirically reproduced against the real
 * plan's own fixture), but a plan that DOES need Topaz reconstruction can
 * legitimately take up to the Sprint 2M Phase 2D bake-off's own observed
 * ~70-130s per call (`docs/deployment/final-artwork-worker.md`'s "Live
 * provider safety" section) — this threshold must never fire while a
 * genuinely-processing Topaz job is still within its own normal range.
 */
export const SIGN_PREPARATION_POLL_INTERVAL_MS = 3000;
export const SIGN_PREPARATION_POLL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Pure time math, extracted for the identical reason
 * `resolveSignProductionCtaState` below already is: directly testable
 * with real numbers, no mounted timer, no mounted router.
 */
export function hasSignPreparationPollingTimedOut(
  inFlightStartedAtMs: number,
  nowMs: number,
): boolean {
  return nowMs - inFlightStartedAtMs >= SIGN_PREPARATION_POLL_TIMEOUT_MS;
}

/**
 * Pure, framework-free. Same precedence `SignProductionAction` always had:
 * print-ready wins over in-flight (a job cannot be both), in-flight wins
 * over any label decision (nothing to click while work is running).
 * Fix QR Review UX Phase: an unresolved machine-readable blocking state
 * now wins over the ordinary "try_again" label — it is never an execution
 * retry condition. Fix Existing Final Sign Candidate Physical-Resolution
 * Metadata Repair Phase: a genuinely-evaluated-and-disagreeing physical-
 * resolution metadata state wins next, for the identical reason — before
 * `failed`/`needsAttention` decide the label for every other case.
 */
export function resolveSignProductionCtaState(
  production: SignPlanOperatorProductionStatus,
): SignProductionCtaState {
  if (production.printReady) return { kind: "print_ready" };
  if (production.inFlight) return { kind: "in_flight" };
  if (
    production.needsAttention &&
    production.requiresVisualAcceptance &&
    !production.visualAcceptanceSatisfied &&
    production.blockedCandidateAssetId
  ) {
    return { kind: "needs_visual_acceptance", assetId: production.blockedCandidateAssetId };
  }
  if (production.needsAttention && isMachineReadableBlocking(production.machineReadableContent)) {
    return { kind: "needs_qr_resolution" };
  }
  if (production.needsAttention && isPhysicalResolutionMetadataBlocking(production.physicalResolutionMetadata)) {
    return { kind: "needs_physical_resolution_repair" };
  }
  return {
    kind: "action",
    label: production.failed || production.needsAttention ? "try_again" : "prepare_artwork",
    needsAttentionNotice: production.needsAttention,
  };
}

/**
 * Stale/Misleading Status Cleanup Phase (real Get Hibachi acceptance
 * incident: after a materially QR-revised candidate was explicitly
 * approved and Print Ready correctly appeared, the "Status" section still
 * read "Needs production review" — a contradiction). That copy came from
 * `plan.riskLabel`, a HISTORICAL fact frozen at planning time (why the
 * repair PLAN itself needed a human to authorize it) — never re-derived as
 * production progresses through authorization, QR replacement, visual
 * acceptance, or Print Ready. It is real information (kept, relabeled —
 * see `page.tsx`), just never the answer to "what is this candidate's
 * CURRENT status right now."
 *
 * This function IS that current answer — the SAME authoritative
 * `resolveSignProductionCtaState` the execution button/download section
 * already use, translated to a plain status sentence, so the page can
 * never show a status contradicting what it is simultaneously doing
 * (exposing Print Ready, showing an unresolved QR panel, etc.). No
 * parallel state is invented here — every branch mirrors a state
 * `SignProductionAction`'s own copy already expresses for the cases where
 * it renders visible text.
 */
export function describeSignProductionCurrentStatus(
  production: SignPlanOperatorProductionStatus,
): string {
  const cta = resolveSignProductionCtaState(production);
  switch (cta.kind) {
    case "print_ready":
      return "Print ready.";
    case "in_flight":
      return "Preparing artwork.";
    case "needs_qr_resolution":
      return "Needs QR resolution before this can be finalized.";
    case "needs_physical_resolution_repair":
      return "Needs a print-size metadata correction before this can be finalized.";
    case "needs_visual_acceptance":
      return "Needs the revised artwork approved before this can be finalized.";
    case "action":
      if (cta.label === "prepare_artwork") return "Not yet prepared for production.";
      // "try_again": either a genuine failed attempt, or a completed job
      // whose candidate needs attention for a reason none of the specific
      // branches above claimed (mirrors `SignProductionAction`'s own
      // `needsAttentionNotice` distinction exactly).
      return cta.needsAttentionNotice
        ? "Needs further review before this can be finalized."
        : "The last production attempt failed and needs to be retried.";
  }
}
