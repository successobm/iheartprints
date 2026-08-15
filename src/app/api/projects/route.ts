import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import { getPersistenceMode } from "@/lib/db";
import {
  ACQUISITION_SESSION_COOKIE,
  acquisitionSessionCookieOptions,
  readAcquisitionSessionTokenFromRequest,
} from "@/lib/http/acquisition-session-cookie";
import { startConversation } from "@/lib/services/conversation-service";

/**
 * Sprint A4: this is the one place an acquisition session is issued, and
 * the one place a project is bound to one.
 *
 * The cookie decides which session a BRAND NEW project belongs to, and
 * nothing else — every later paid-value gate reads
 * `print_projects.acquisition_session_id` instead, so a cleared, forged, or
 * absent cookie on a subsequent request cannot grant a second free concept
 * on a project that already has one.
 *
 * The cookie is re-set on every create, not only when a new session is
 * issued, so a customer whose cookie is close to expiry keeps their session
 * rather than silently becoming a new prospect.
 */
export async function POST(request: Request) {
  try {
    const session = await getCapabilityGraph().acquisition.resolveOrCreateSession(
      readAcquisitionSessionTokenFromRequest(request),
    );

    const snapshot = await startConversation(session.id);

    const response = NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
    response.cookies.set(
      ACQUISITION_SESSION_COOKIE,
      session.sessionToken,
      acquisitionSessionCookieOptions(),
    );
    return response;
  } catch (error) {
    console.error("Failed to create project", error);
    return NextResponse.json(
      { error: "Failed to start conversation" },
      { status: 500 },
    );
  }
}
