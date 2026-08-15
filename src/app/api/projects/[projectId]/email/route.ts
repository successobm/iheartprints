import { NextResponse } from "next/server";

import { getPersistenceMode } from "@/lib/db";
import { captureAcquisitionEmail } from "@/lib/services/conversation-service";
import { captureEmailBodySchema } from "./schema";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Sprint A4: the customer's email, captured so they can keep working on
 * their design.
 *
 * Explicitly NOT: account creation, sign-up, password auth, an OTP step,
 * email verification, a marketing subscription, or a CRM write. There is no
 * consent checkbox because there is no consent being collected — the
 * address is used to continue this design session, and the UI says so.
 *
 * Idempotent: re-submitting the same address is a no-op that returns the
 * same state, and a corrected address simply replaces the old one without
 * moving the original capture timestamp.
 *
 * Grants nothing. This route cannot restore a spent free concept, authorize
 * generation, or unlock finalization — those decisions belong to the
 * capabilities that own the spend and are unaffected by anything here.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = captureEmailBodySchema.safeParse(json);

    if (!parsed.success) {
      // Deliberately the same customer-facing wording the validator itself
      // produces for a malformed address: a caller must not be able to tell
      // "your body was the wrong shape" from "that isn't an email", and the
      // customer does not benefit from the distinction either.
      return NextResponse.json(
        { error: "That doesn't look like an email address." },
        { status: 400 },
      );
    }

    const result = await captureAcquisitionEmail(projectId, parsed.data.email);
    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    return NextResponse.json({
      ...result.snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    // The address itself is never logged — the whole point of capturing as
    // little as possible is undone if it lands in operational logs on every
    // failure.
    console.error("Failed to capture acquisition email");
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "We couldn't save that right now. Please try again." },
      { status: 500 },
    );
  }
}
