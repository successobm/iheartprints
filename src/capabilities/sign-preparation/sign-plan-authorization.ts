/**
 * LIVE PRODUCT BLOCKER #4: the one rule this whole authority exists to
 * enforce — WHO may authorize a plan for production, given its risk
 * classification. Deliberately a single pure function, not a subsystem:
 *
 *   auto_safe        — the engine already proved this repair safe to
 *                       propose automatically; either the customer's own
 *                       self-service action or an operator may authorize it.
 *   review_required   — the engine explicitly could not prove this safe on
 *                       its own (Signs Phase S1's own doctrine: "uncertainty
 *                       NEVER downgrades to safe"). ONLY an internal
 *                       operator may authorize it — a customer's own click
 *                       must never be treated as sufficient production-risk
 *                       judgment for a decision the engine itself flagged.
 *   blocked           — the planner never formulates a plan for a blocked
 *                       outcome at all (`plan: null`), so there is
 *                       structurally nothing to authorize. Fails closed
 *                       regardless of actor.
 *
 * Consumed at TWO independent points, deliberately not shared as an import
 * between them: `SignPreparationCapability.authorizeSignRepairPlan` (the
 * earliest possible refusal — before any durable authorization is ever
 * written) and `print-validation/print-validation-capability.ts`'s
 * `validateRigidSign` (which must never depend on `sign-preparation` —
 * `capability-boundaries.ts`'s dependency-direction rule, the same reason
 * `planOverallRisk` itself is carried as a plain string there). Both copies
 * must stay in lockstep by inspection; this is the ONE authoritative
 * definition either should ever encode.
 */

import type { SignRiskClass } from "./contracts";

export function isAuthorizationSufficientForRisk(
  risk: SignRiskClass,
  authorizedBy: "customer" | "operator",
): boolean {
  switch (risk) {
    case "auto_safe":
      return authorizedBy === "customer" || authorizedBy === "operator";
    case "review_required":
      return authorizedBy === "operator";
    case "blocked":
      return false;
  }
}
