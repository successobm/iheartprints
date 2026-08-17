import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import { CHECKOUT_UNAVAILABLE_MESSAGE } from "@/capabilities/payment";

import { createCheckoutBodySchema } from "./schema";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Sprint A5.3: creates (or reuses) one checkout session for a project's
 * production unlock.
 *
 * WHAT THIS ROUTE ACCEPTS: a project id, from the path. That is the entire
 * input surface. The body must be empty — `createCheckoutBodySchema` is a
 * `.strict()` empty object, so an amount, a currency, a price id, a
 * production profile, another project's id, an approval id, or a session id
 * is a 400 rather than a silently ignored field.
 *
 * WHAT THIS ROUTE RETURNS: a provider checkout URL, and nothing else. No
 * amount, no currency, no provider name, no session id, no transaction id, no
 * email. The URL is short-lived, provider-issued, and not a secret; every
 * other provider value stays server-side (§23d).
 *
 * WHAT THIS ROUTE DOES NOT DO: grant anything. A successful response means a
 * payment page exists — not that anything was paid, and emphatically not that
 * the project may be produced. `ProductionUnlock` is untouched by this entire
 * code path, and only a verified provider webhook (A5.4) will ever create
 * one.
 *
 * KNOWN, DOCUMENTED LIMITATION — the bearer-project-id weakness. Like every
 * other project route in this codebase, authorization here is "you know the
 * project's UUID". Nothing checks that the caller's acquisition cookie
 * matches the project's durable binding. That is pre-existing (§24) and is
 * deliberately not fixed in this slice, but it is worth stating precisely
 * what it does and does not permit HERE: a stranger holding a project id
 * could cause a checkout session to be created for somebody else's project
 * and could pay for it. They cannot redirect the resulting entitlement — the
 * unlock lands on the project, and the buyer's email is read from the
 * project's own session, not the caller's. So the weakness is "an attacker
 * can spend their own money on a stranger's project", not "an attacker can
 * obtain a stranger's design". It becomes materially more serious once a paid
 * project's deliverables are worth stealing, and route-level project
 * ownership remains a launch blocker for A5.7 / security hardening.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;

    // An absent body is the expected shape and is treated as `{}`. A present
    // but malformed one — or one carrying any property at all — is rejected.
    let body: unknown = {};
    const raw = await request.text();
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Invalid request" }, 400);
      }
    }

    const parsed = createCheckoutBodySchema.safeParse(body);
    if (!parsed.success) {
      // Deliberately uninformative: naming the offending field would tell a
      // caller exactly which commercial parameter to try next.
      return json({ error: "Invalid request" }, 400);
    }

    const result = await getCapabilityGraph().payment.createCheckout(projectId);
    if (!result.ok) {
      // One uniform refusal for every internal reason — the real one is
      // logged server-side. Distinguishable refusals would let a caller
      // enumerate which projects exist, which are already paid for, and which
      // are internal, purely by reading error text.
      //
      // 409 rather than 404/403 for the same reason: the status must not
      // reconstruct the distinction the message refuses to make.
      return json({ error: result.customerMessage }, 409);
    }

    return json({ checkoutUrl: result.checkoutUrl }, 200);
  } catch (error) {
    // Never forwards the error's message — it could name the provider, an
    // endpoint, a configuration variable, or an internal id.
    console.error("Failed to create production unlock checkout");
    void error;
    return json({ error: CHECKOUT_UNAVAILABLE_MESSAGE }, 500);
  }
}

/**
 * `no-store` on every path, including failures. A checkout URL is
 * single-customer, short-lived, and must never be held by a shared cache or a
 * CDN — and a cached refusal would be just as wrong the moment the project's
 * state changes.
 */
function json(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
