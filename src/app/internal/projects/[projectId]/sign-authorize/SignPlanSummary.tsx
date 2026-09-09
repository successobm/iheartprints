/**
 * Simplify Signs Production Review Phase: the normal, human-language
 * summary of a not-yet-authorized plan — the ONE thing an operator needs
 * to read before deciding whether to approve. Pure presentation: every
 * sentence it renders came from `sign-preparation-copy.ts`'s
 * `describeSignPlanForCustomer` (via `SignPlanOperatorView.findings`/
 * `proposedAction`, `sign-preparation-operator-copy.ts`) — the SAME
 * translation authority the customer-facing chat surface already uses,
 * reused rather than duplicated. This component never inspects a defect
 * code, a step kind, a pixel count, or an RGB value; it renders nothing
 * `sign-preparation-copy.ts` did not already decide to say.
 *
 * Deliberately excludes everything Section 3 of this phase's own task
 * names as implementation detail — plan risk classification, planKey,
 * raw pixel/RGB step params, repair-operation names, authorization
 * terminology. Those remain fully available, unchanged, inside
 * "Production details" (collapsed by default) for anyone who deliberately
 * opens it — this component is only ever the FIRST thing an operator
 * reads, never the only place the facts exist.
 */
export function SignPlanSummary({
  orderedWidthIn,
  orderedHeightIn,
  findings,
  proposedAction,
  reviewRequired,
}: {
  orderedWidthIn: number;
  orderedHeightIn: number;
  findings: string[];
  proposedAction: string | null;
  reviewRequired: boolean;
}) {
  const headline = reviewRequired ? "Artwork needs review" : "Ready to prepare";

  return (
    <div className="flex flex-col gap-2" data-sign-plan-summary>
      <p className="text-base font-semibold text-ink">{headline}</p>
      <p className="text-sm text-muted">
        {orderedWidthIn}&quot; × {orderedHeightIn}&quot;
      </p>
      {findings.map((finding) => (
        <p key={finding} className="text-sm text-ink">
          {finding}
        </p>
      ))}
      <p className="text-sm text-ink">
        {proposedAction ?? "This artwork already fits the ordered size well — nothing needs to change."}
      </p>
    </div>
  );
}
