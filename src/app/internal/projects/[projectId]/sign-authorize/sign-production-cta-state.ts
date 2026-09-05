import type { SignMachineReadableContentSummary, SignPlanOperatorProductionStatus } from "@/capabilities/sign-preparation";

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
 * Pure, framework-free. Same precedence `SignProductionAction` always had:
 * print-ready wins over in-flight (a job cannot be both), in-flight wins
 * over any label decision (nothing to click while work is running).
 * Fix QR Review UX Phase: an unresolved machine-readable blocking state
 * now wins over the ordinary "try_again" label — it is never an execution
 * retry condition — before `failed`/`needsAttention` decide the label for
 * every other case.
 */
export function resolveSignProductionCtaState(
  production: SignPlanOperatorProductionStatus,
): SignProductionCtaState {
  if (production.printReady) return { kind: "print_ready" };
  if (production.inFlight) return { kind: "in_flight" };
  if (production.needsAttention && isMachineReadableBlocking(production.machineReadableContent)) {
    return { kind: "needs_qr_resolution" };
  }
  return {
    kind: "action",
    label: production.failed || production.needsAttention ? "try_again" : "prepare_artwork",
    needsAttentionNotice: production.needsAttention,
  };
}
