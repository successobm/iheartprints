import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCheckoutBodySchema } from "./schema";

/**
 * Sprint A5.3 — the checkout route's REQUEST-BODY AUTHORITY, which is that it
 * has none.
 *
 * These assertions run against the schema directly rather than by booting a
 * Next.js route: the schema IS the boundary (the route's only use of the body
 * is `safeParse`), and testing it directly makes the property provable
 * without a server, a capability graph, or a payment provider — the same
 * shape `finalize/schema.ts` and `email/schema.ts` are tested in.
 *
 * The property: every commercial parameter a client might try to smuggle is
 * REJECTED, not silently stripped. `.strip()` — zod's default — would accept
 * the request, discard the field, and charge the correct price anyway, which
 * is safe but invisible. Loud rejection makes the boundary observable from
 * the outside, which is what makes it testable at all.
 */

describe("Sprint A5.3 — checkout route body carries no commercial authority", () => {
  it("accepts an empty body, which is the entire supported request shape", () => {
    assert.equal(createCheckoutBodySchema.safeParse({}).success, true);
  });

  it("REJECTS every commercial parameter a client could try to supply", () => {
    const attempts: Record<string, unknown>[] = [
      { amountMinor: 1 },
      { amount: 1 },
      { amount_minor: 1 },
      { currency: "usd" },
      { priceId: "price_attacker" },
      { providerPriceId: "price_attacker" },
      { productionProfile: "apparel_vector" },
      { production_profile: "signage" },
      { projectId: "00000000-0000-4000-8000-000000000000" },
      { acquisitionSessionId: "00000000-0000-4000-8000-000000000000" },
      { approvalId: "00000000-0000-4000-8000-000000000000" },
      { artworkVersionId: "00000000-0000-4000-8000-000000000000" },
      { email: "attacker@example.com" },
      { provider: "stripe" },
      { successUrl: "https://attacker.example/" },
      { cancelUrl: "https://attacker.example/" },
      // A realistic combined attempt: a plausible-looking cheap purchase of
      // somebody else's project.
      {
        amountMinor: 1,
        currency: "usd",
        productionProfile: "apparel_raster",
        projectId: "11111111-1111-4111-8111-111111111111",
      },
    ];

    for (const body of attempts) {
      assert.equal(
        createCheckoutBodySchema.safeParse(body).success,
        false,
        `body ${JSON.stringify(body)} must be REJECTED, not silently stripped`,
      );
    }
  });

  it("rejects a non-object body outright", () => {
    for (const body of [null, 1, "amountMinor=1", true, [], ["amountMinor"]]) {
      assert.equal(
        createCheckoutBodySchema.safeParse(body).success,
        false,
        `body ${JSON.stringify(body)} must be rejected`,
      );
    }
  });

  it("parses to an object with no keys, so nothing downstream can read a client value", () => {
    const parsed = createCheckoutBodySchema.safeParse({});
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.deepEqual(Object.keys(parsed.data), []);
  });
});
