/**
 * Sign Production Review Print-Ready Authority Repair (real Get Hibachi
 * production incident, second occurrence: the Sign Production Review page
 * exposed "Print-ready" / "Download corrected artwork" for a candidate
 * whose validation predated the `physical_resolution_metadata` check
 * entirely).
 *
 * THE BUG THIS REPAIRS: `ProductionAssetValidation.status === "ready"` is
 * computed by `aggregateStatus` (`print-validation-capability.ts`) from
 * WHATEVER checks happen to be present in that ONE persisted
 * `report.checks` array — a check code that did not exist yet when a
 * validation was written (e.g. `physical_resolution_metadata`, introduced
 * after the real historical candidate's validation) is simply ABSENT from
 * that array, never "failing" it — `aggregateStatus` only ever iterates
 * checks that exist. A stale validation can therefore read `status:
 * "ready"` forever, even after a NEW required blocking check is
 * introduced, because nothing ever re-runs it against the current
 * canonical rule set. The same is true of an incremental `mergeChecks`
 * update (`sign-qr-preservation-service.ts`) that only ever replaces NAMED
 * checks and carries every other one forward unexamined.
 *
 * This module closes that gap WITHOUT re-running
 * `PrintValidationCapability.validateArtwork` (this profile's full
 * computation needs a live `RigidSignPlanEvidence` the authority layers
 * that need this — candidate resolution, the operator review page — do not
 * have and must not reconstruct). Instead it verifies PRESENCE, not merely
 * a passing top-level `status`, of every check
 * `print-validation-capability.ts`'s own canonical `validateRigidSign`
 * unconditionally computes for a fully-evaluated production candidate.
 *
 * ONE authoritative function, reused identically by:
 *   - the download/current-candidate authority (`final-artwork-capability
 *     .ts`'s `resolveSatisfiedSignProductionDelivery` /
 *     `resolveBlockedSignProductionCandidateFor` /
 *     `resolveTrustworthySignRepairParentFor`), and
 *   - the operator review page's own presentation-only peek
 *     (`sign-plan-operator-review.ts`'s `resolveSignProductionStatus`)
 * — so the two can never again independently answer "is this print ready"
 * and silently disagree.
 */
import type { PrintValidationCheckCode } from "./contracts";

/**
 * Mirrors `print-validation-capability.ts`'s own `validateRigidSign` — the
 * single canonical function that decides which checks a rigid-sign
 * production candidate is ever judged against — deliberately NOT imported
 * (this module must stay callable from `final-artwork` and
 * `sign-preparation` without pulling in that ~2500-line capability
 * implementation file; the same duplication discipline this codebase
 * already applies at every other capability boundary, e.g.
 * `sign-qr-preservation-service.ts`'s own duplicated
 * `buildPhysicalResolutionCheck`). Any check code `validateRigidSign` adds
 * and marks unconditionally blocking must be added here too, by
 * inspection — both copies encode the identical rule.
 *
 * Deliberately EXCLUDES `validation_profile`, `edge_intent_advisory`, and
 * `resolution_provenance` — all three are `severity: "info"` in
 * `validateRigidSign`, never blocking, and never required for readiness.
 */
export const RIGID_SIGN_REQUIRED_PRINT_READY_CHECK_CODES: readonly PrintValidationCheckCode[] = [
  "asset_exists",
  "content_type",
  "raster_dimensions_known",
  "repair_plan_recorded",
  "source_lineage",
  "executed_plan_matches_recorded_plan",
  "exact_physical_dimensions",
  "effective_resolution",
  "no_unintended_transparency",
  "content_within_bounds",
  "substrate_boundary_semantics",
  "protected_content_safe_inset",
  "machine_readable_content_preserved",
  "physical_resolution_metadata",
] as const;

interface LooseCheckRow {
  check?: unknown;
  status?: unknown;
  severity?: unknown;
}

/**
 * Reads a persisted `ProductionAssetValidation.report`'s generic
 * `Record<string, unknown>` shape — never a strictly-typed
 * `PrintValidationReport`; a jsonb round-trip is never trusted at the type
 * level here, mirroring every other reader of this same column throughout
 * the codebase (`sign-plan-operator-review.ts`'s `readFitToProductionSummary`,
 * `sign-qr-preservation-service.ts`'s `mergeChecks`, etc.) — and returns
 * `true` ONLY when EVERY code in `RIGID_SIGN_REQUIRED_PRINT_READY_CHECK_CODES`
 * is present with a row that is either non-blocking (`severity !==
 * "blocking"`, e.g. an `accepted_as_supplied` QR acknowledgment) or
 * `status === "pass"`.
 *
 * A code that is MISSING entirely — never evaluated, computed by a stale
 * pre-this-check version of `validateRigidSign`, or carried over unchanged
 * from a DIFFERENT candidate's validation via an incremental merge — fails
 * closed exactly like a present-but-failing row. Never trusts the report's
 * own top-level `status` field, which is exactly the stale value this
 * module exists to stop trusting blindly.
 */
export function isRigidSignValidationTrulyPrintReady(
  report: Record<string, unknown> | null | undefined,
): boolean {
  const checks = report?.checks;
  if (!Array.isArray(checks)) return false;
  const rows = checks as LooseCheckRow[];
  return RIGID_SIGN_REQUIRED_PRINT_READY_CHECK_CODES.every((code) => {
    const row = rows.find((r) => r.check === code);
    if (!row) return false;
    if (row.severity !== "blocking") return true;
    return row.status === "pass";
  });
}
