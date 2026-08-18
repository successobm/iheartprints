import { NextResponse } from "next/server";

import { getCapabilityGraph } from "@/capabilities/composition";
import { STRIPE_SIGNATURE_HEADER } from "@/capabilities/payment";

/**
 * Sprint A5.4: the verified payment webhook. MACHINE-TO-MACHINE ONLY.
 *
 * THE ONLY PATH FROM MONEY TO ENTITLEMENT runs through here:
 *
 *   verified signature → PaymentEvent → atomic reconciliation
 *     → PaymentTransaction paid + ProductionUnlock active
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT HAVE, each for a reason:
 *
 *   no project id in the URL   the project is derived from the durable
 *                              transaction row, inside the database. A path
 *                              parameter would be a second, forgeable way to
 *                              name what gets unlocked.
 *   no cookie or session       a payment provider has neither. Reading one
 *                              would mean a browser could reach this path
 *                              with an identity, which is the shape of the
 *                              redirect-as-authority bug this whole sprint
 *                              exists to make impossible.
 *   no query parameters        nothing here is influenced by the URL at all.
 *   no request-derived origin  nothing is redirected or echoed.
 *
 * THE RAW BODY IS READ EXACTLY ONCE, as text, and handed on untouched. It is
 * never `JSON.parse`d here — the signature covers bytes, and a route that
 * parsed first would be interpreting attacker-supplied structure before
 * establishing that an attacker did not supply it. Next.js gives one shot at
 * the body stream, so `request.text()` is called once and only once.
 */
export async function POST(request: Request) {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    // A body that cannot even be read is not a verifiable request.
    return json({ received: false }, 400);
  }

  const signatureHeader = request.headers.get(STRIPE_SIGNATURE_HEADER);

  try {
    const result = await getCapabilityGraph().payment.handleWebhook({
      rawBody,
      signatureHeader,
    });

    if (result.status === "rejected") {
      // Uninformative by design. An attacker probing this endpoint learns
      // nothing about which part of their forgery failed, and a legitimate
      // misconfiguration is diagnosable from the server's own logs.
      return json({ received: false }, 400);
    }

    // 200 for every DECIDED outcome, including the refusals. `unmatched` and
    // `rejected_mismatch` are final: re-delivering the same event would reach
    // the same conclusion, so answering anything else would turn a permanent
    // refusal into an infinite provider retry loop.
    //
    // The body says only that the event was received. It never reports what
    // was decided — telling the caller would leak whether a given transaction
    // id exists, which is exactly what a prober would want to know.
    return json({ received: true }, 200);
  } catch (error) {
    // A genuine infrastructure fault. 5xx is CORRECT here and only here: the
    // event was real and verified, and the provider SHOULD retry once the
    // database is reachable again. Never forwards the error's message — it
    // could name a table, a function, an id, or a credential.
    console.error("Payment webhook failed");
    void error;
    return json({ received: false }, 500);
  }
}

/**
 * `no-store` on every path. A payment notification must never be held by a
 * cache or a CDN, and a cached response would also mean a retry could be
 * answered without the request ever reaching this process.
 */
function json(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
