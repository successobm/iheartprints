/**
 * Phase 28P: the pure decision behind this operator page's render branch —
 * extracted for the same reason `internal-access-page-state.ts` extracts
 * `resolveInternalAccessPageState`: this repo's test tooling has no DOM and
 * no Next.js request context, so the actual branch logic lives here, with
 * no framework dependency at all.
 */
import type { ContinuationEligibility } from "@/capabilities/artwork-preparation/continue-as-internal-job";

export type ContinuePageState =
  | { kind: "unconfigured" }
  | { kind: "not_internal" }
  | { kind: "not_found" }
  | { kind: "ineligible"; reason: string }
  | { kind: "already_continued"; newProjectId: string }
  | { kind: "ready" };

export function resolveContinuePageState(input: {
  configured: boolean;
  isInternal: boolean;
  eligibility: ContinuationEligibility | null;
}): ContinuePageState {
  if (!input.configured) return { kind: "unconfigured" };
  if (!input.isInternal) return { kind: "not_internal" };
  const eligibility = input.eligibility;
  if (!eligibility || eligibility.status === "not_found") return { kind: "not_found" };
  if (eligibility.status === "ineligible") return { kind: "ineligible", reason: eligibility.reason };
  if (eligibility.status === "already_continued") {
    return { kind: "already_continued", newProjectId: eligibility.newProjectId };
  }
  return { kind: "ready" };
}
