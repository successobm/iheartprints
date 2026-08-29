import Link from "next/link";
import { cookies } from "next/headers";

import { describeContinuationEligibility } from "@/capabilities/artwork-preparation/continue-as-internal-job";
import { isInternalAccessConfigured } from "@/lib/config/internal-access-config";
import { ACQUISITION_SESSION_COOKIE } from "@/lib/http/acquisition-session-cookie";
import { getProjectRepository } from "@/lib/db";

import { ContinueAsInternalJobButton } from "./ContinueAsInternalJobButton";
import { resolveContinuePageState } from "./continue-page-state";

type PageProps = {
  params: Promise<{ projectId: string }>;
};

/**
 * Phase 28P — the internal operator entry point for "Continue as Internal
 * Job". Mirrors `/internal/access/page.tsx` exactly: a Server Component
 * that reads the session cookie once, decides a small enum of render
 * states server-side, and never renders the action to a session that
 * isn't genuinely internal — reachability of this URL grants nothing on
 * its own, exactly like that page.
 *
 * There is deliberately no project browser here. This app has no
 * `/projects/[id]` route anywhere — project selection is client-side
 * (`ChatApp.tsx`'s own `localStorage` key) — so an internal operator who
 * knows which customer project they're picking up navigates here directly
 * by id, the same way `/internal/access` itself is a plain URL Eric
 * navigates to rather than a link surfaced in customer UI.
 */
export default async function ContinueAsInternalJobPage({ params }: PageProps) {
  const { projectId } = await params;
  const configured = isInternalAccessConfigured();

  let isInternal = false;
  if (configured) {
    const cookieStore = await cookies();
    const token = cookieStore.get(ACQUISITION_SESSION_COOKIE)?.value ?? null;
    if (token) {
      const repo = getProjectRepository();
      const session = await repo.getAcquisitionSessionByToken(token).catch(() => null);
      isInternal = session?.entitlement === "internal";
    }
  }

  const eligibility = configured && isInternal
    ? await describeContinuationEligibility(getProjectRepository(), projectId)
    : null;

  const pageState = resolveContinuePageState({ configured, isInternal, eligibility });

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Continue as Internal Job</h1>
        <p className="mt-1 text-sm text-muted">
          Carry this project&apos;s approved, already-corrected artwork into a new internal production job.
        </p>
      </div>

      {pageState.kind === "unconfigured" ? (
        <p className="text-sm text-muted" data-continue-unconfigured>
          Internal access isn&apos;t configured for this deployment.
        </p>
      ) : pageState.kind === "not_internal" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink" data-continue-not-internal>
            This browser doesn&apos;t have internal production access.
          </p>
          <Link
            href="/internal/access"
            className="rounded-full bg-ink px-3.5 py-2 text-center text-sm font-medium text-white transition hover:bg-ink/90"
          >
            Get internal access
          </Link>
        </div>
      ) : pageState.kind === "not_found" ? (
        <p className="text-sm text-ink" data-continue-not-found>
          No project with that id was found.
        </p>
      ) : pageState.kind === "ineligible" ? (
        <p className="text-sm text-ink" data-continue-ineligible>
          {pageState.reason}
        </p>
      ) : pageState.kind === "already_continued" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink" data-continue-already-done>
            This artwork was already continued as an internal job.
          </p>
          <ContinueAsInternalJobButton sourceProjectId={projectId} />
        </div>
      ) : (
        <ContinueAsInternalJobButton sourceProjectId={projectId} />
      )}
    </div>
  );
}
