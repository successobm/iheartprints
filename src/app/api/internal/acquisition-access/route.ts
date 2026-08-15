import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  INTERNAL_ACCESS_KEY_HEADER,
  verifyInternalAccessKey,
} from "@/lib/config/internal-access-config";
import {
  ACQUISITION_SESSION_COOKIE,
  acquisitionSessionCookieOptions,
  readAcquisitionSessionTokenFromRequest,
} from "@/lib/http/acquisition-session-cookie";

/**
 * Sprint A4 (Goal 16): grants the current browser session the internal
 * entitlement, so iHeartPrints stays usable for real Print'em All work and
 * live acceptance testing after the acquisition gate exists.
 *
 * THE SHAPE OF THIS BYPASS IS THE POINT.
 *
 * It is a deliberate action — somebody presents a real secret to a real
 * endpoint — recorded with an audit timestamp on the session it grants
 * (`acquisition_sessions.internal_granted_at`). Production internal use is
 * therefore something that happened, at a time, and can be found afterwards.
 *
 * None of the cheap alternatives were used, and none may be added later:
 * no hardcoded operator email, no browser-local flag, no secret query
 * string, and no `NODE_ENV` check. See `internal-access-config.ts` for why
 * each of those is not a control.
 *
 * The grant lands on the SESSION, not on a project, so it applies to
 * whatever the operator does next in that browser — including projects they
 * have not created yet. It does not retroactively change projects already
 * bound to a different session, which is correct: entitlement travels with
 * the session a project belongs to.
 *
 * Responses are deliberately uninformative. Whether the key is wrong or the
 * feature is unconfigured, the caller gets the same 401 — an unauthenticated
 * probe must not be able to map the deployment's configuration.
 */
export async function POST(request: Request) {
  const result = verifyInternalAccessKey(
    request.headers.get(INTERNAL_ACCESS_KEY_HEADER),
  );

  if (!result.authorized) {
    // Logged server-side with the reason (never the key, never the caller's
    // value) so a misconfiguration is diagnosable without the response
    // telling an attacker which of the two it was.
    console.warn("Internal acquisition access refused", {
      reason: result.reason,
    });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const graph = getCapabilityGraph();
    const session = await graph.acquisition.resolveOrCreateSession(
      readAcquisitionSessionTokenFromRequest(request),
    );
    const granted = await graph.acquisition.grantInternalEntitlement(session.id);
    if (!granted) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    console.info("Internal acquisition access granted", {
      acquisitionSessionId: granted.id,
      grantedAt: granted.internalGrantedAt,
    });

    // Never echoes the session token in the body — it goes back exactly one
    // way, as an httpOnly cookie.
    const response = NextResponse.json({ ok: true });
    response.cookies.set(
      ACQUISITION_SESSION_COOKIE,
      granted.sessionToken,
      acquisitionSessionCookieOptions(),
    );
    return response;
  } catch (error) {
    console.error("Failed to grant internal acquisition access", error);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
