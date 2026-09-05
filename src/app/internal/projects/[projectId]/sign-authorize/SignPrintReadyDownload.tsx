import type { SignPlanOperatorProductionStatus } from "@/capabilities/sign-preparation";
import { resolveSignProductionCtaState } from "./sign-production-cta-state";

/**
 * Sign Production Review Print-Ready Authority Repair (real Get Hibachi
 * production incident, second occurrence): the ONLY place this workflow
 * ever renders a "Print-ready" heading or a final-artwork download link —
 * moved to the very BOTTOM of the workflow, after every validation/repair
 * panel (QR, print size metadata, fit-to-production), per Section H of
 * that phase.
 *
 * Server Component, not client — there is nothing to click-and-poll here
 * (unlike `SignProductionAction`'s "Prepare artwork"): this either renders
 * the download link or renders nothing at all, decided purely from the
 * SAME `resolveSignProductionCtaState(production)` `SignProductionAction`
 * itself uses for every OTHER state, so the two components can never
 * independently disagree about whether the candidate is truly print ready.
 * That CTA state is itself derived from `SignPlanOperatorProductionStatus
 * .printReady`, which — since the Print-Ready Authority Repair — requires
 * `isRigidSignValidationTrulyPrintReady` (`print-validation/rigid-sign-
 * print-ready-authority.ts`): every check that profile currently requires
 * must be PRESENT and passing in the CURRENT candidate's own validation,
 * never merely a stale `status: "ready"` computed before a check like
 * `physical_resolution_metadata` existed.
 *
 * Copy describes the artifact's CURRENT authority ("Print-ready file" /
 * "Download print-ready artwork"), never its repair history ("corrected").
 */
export function SignPrintReadyDownload({
  projectId,
  production,
}: {
  projectId: string;
  production: SignPlanOperatorProductionStatus;
}) {
  const cta = resolveSignProductionCtaState(production);
  if (cta.kind !== "print_ready") return null;

  return (
    <section className="flex flex-col gap-2 border-t border-ink/10 pt-4" data-sign-production-ready>
      <p className="text-sm font-semibold text-ink">Print-ready file</p>
      <a
        href={`/api/internal/projects/${projectId}/sign-artwork/download`}
        className="rounded-full bg-ink px-3.5 py-2 text-center text-sm font-medium text-white transition hover:bg-ink/90"
        data-testid="sign-download-link"
      >
        Download print-ready artwork
      </a>
    </section>
  );
}
