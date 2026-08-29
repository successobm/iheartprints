import { cookies } from "next/headers";
import Link from "next/link";

import { isInternalAccessConfigured } from "@/lib/config/internal-access-config";
import { ACQUISITION_SESSION_COOKIE } from "@/lib/http/acquisition-session-cookie";
import { getProjectRepository } from "@/lib/db";

import { InternalAccessForm } from "./InternalAccessForm";
import { resolveInternalAccessPageState } from "./internal-access-page-state";

/**
 * Phase 28M.1: the one-time operator bootstrap for the internal/system-admin
 * entitlement `POST /api/internal/acquisition-access` already grants.
 *
 * NOT A NEW AUTHORITY. This page changes nothing about who may become
 * internal or what internal means — it only removes the DevTools/Console/
 * manual-POST friction of reaching that existing, unchanged mechanism. The
 * actual grant still happens exactly where it always has: a real secret,
 * presented to that real endpoint, compared in constant time, recorded with
 * an audit timestamp. This page is the form; the endpoint is still the gate.
 *
 * WHY THIS IS SAFE TO SHIP UNCONDITIONALLY (no NODE_ENV/hostname check)
 *
 * Reachability is not authority here, by the same reasoning
 * `internal-access-config.ts` already established for the API route itself:
 * a visitor who finds this URL in any environment still needs the real,
 * length-floored, constant-time-compared key — the page cannot grant
 * anything by existing. If `IHEARTPRINTS_INTERNAL_ACCESS_KEY` is not
 * configured in this deployment, `isInternalAccessConfigured()` (the SAME
 * predicate the route already fails closed on) is reused here to say so
 * plainly rather than show a form that could only ever 401 — no new
 * environment predicate was invented for this.
 *
 * WHY THIS IS A SERVER COMPONENT
 *
 * The "already internal" shortcut below reads the session cookie and looks
 * up the session's entitlement server-side, via a plain read
 * (`repo.getAcquisitionSession`) that never creates a session for an
 * anonymous visitor the way `resolveOrCreateSession` would. Nothing secret
 * is computed here — `isInternalAccessConfigured()` returns a boolean, never
 * the key — but doing the check server-side keeps this page consistent with
 * this codebase's existing habit of never handing a client component more
 * than it needs.
 */
export default async function InternalAccessPage() {
  const configured = isInternalAccessConfigured();

  let alreadyInternal = false;
  if (configured) {
    const cookieStore = await cookies();
    const token = cookieStore.get(ACQUISITION_SESSION_COOKIE)?.value ?? null;
    if (token) {
      const repo = getProjectRepository();
      // Phase 28P bugfix: the cookie carries the session's TOKEN, and
      // `getAcquisitionSession` looks up by internal `id` — a different
      // column. This shortcut was silently always false since Phase 28M.1;
      // no authorization semantics change (the underlying grant/cookie/gate
      // are untouched), only this cosmetic "already granted" display now
      // actually recognizes a real internal session.
      const session = await repo.getAcquisitionSessionByToken(token).catch(() => null);
      alreadyInternal = session?.entitlement === "internal";
    }
  }

  const pageState = resolveInternalAccessPageState({ configured, alreadyInternal });

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Internal Production Access</h1>
        <p className="mt-1 text-sm text-muted">
          For Print&apos;em All internal production use. Ordinary customers never see this page.
        </p>
      </div>

      {pageState === "unconfigured" ? (
        <p className="text-sm text-muted" data-internal-access-unconfigured>
          Internal access isn&apos;t configured for this deployment.
        </p>
      ) : pageState === "already_internal" ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink" data-internal-access-already-granted>
            This browser already has internal production access.
          </p>
          <Link
            href="/"
            className="rounded-full bg-ink px-3.5 py-2 text-center text-sm font-medium text-white transition hover:bg-ink/90"
          >
            Continue to iHeartPrints
          </Link>
        </div>
      ) : (
        <InternalAccessForm />
      )}
    </div>
  );
}
