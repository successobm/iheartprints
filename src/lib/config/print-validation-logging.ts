/**
 * Sprint 2M Phase 2A: server-side-only diagnostics for provisional print
 * validation. Mirrors `generation-provider-logging.ts` — whitelisted fields
 * only, never a full `PrintValidationReport` (no check reasons, no
 * `ProductionRequirements`, no asset/storage detail, no brief text). This
 * is observability for operators, not a persisted or customer-facing
 * record — see ARCHITECTURE.md's "Provisional Print Readiness" section for
 * why the result itself is not written to `ArtworkVersion`.
 */

import type { PrintValidationStatus } from "@/capabilities/print-validation";

export interface ProvisionalPrintValidationLogDetails {
  projectId: string;
  artworkVersionId: string;
  generationJobId: string;
  status: PrintValidationStatus;
  requiredTransformationCount: number;
  blockingIssueCount: number;
}

/** Never customer-facing. Whitelisted fields only — see module doc. */
export function logProvisionalPrintValidation(
  details: ProvisionalPrintValidationLogDetails,
): void {
  console.info("[print-validation] provisional readiness computed", {
    projectId: details.projectId,
    artworkVersionId: details.artworkVersionId,
    generationJobId: details.generationJobId,
    status: details.status,
    requiredTransformationCount: details.requiredTransformationCount,
    blockingIssueCount: details.blockingIssueCount,
  });
}

export interface ProvisionalPrintValidationFailureLogDetails {
  projectId: string;
  generationJobId: string;
  message: string;
}

/**
 * Provisional print validation must never destabilize a successful concept
 * generation (Goal 9) — this is the log line for when computing it itself
 * throws. The job continues normally either way.
 */
export function logProvisionalPrintValidationFailure(
  details: ProvisionalPrintValidationFailureLogDetails,
): void {
  console.error("[print-validation] provisional validation failed (non-fatal)", {
    projectId: details.projectId,
    generationJobId: details.generationJobId,
    message: details.message,
  });
}
