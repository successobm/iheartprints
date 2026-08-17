import { z } from "zod";

/**
 * Sprint A5.3: the request body carries NO COMMERCIAL AUTHORITY, and this
 * schema is how that is enforced rather than merely intended.
 *
 * `.strict()` on an empty object means any property at all is a validation
 * failure — not stripped, not ignored, REJECTED. So a body containing
 * `amountMinor`, `currency`, `providerPriceId`, `productionProfile`,
 * `projectId`, `acquisitionSessionId`, `approvalId`, or anything else is a
 * 400, and there is no code path in which such a value could be read.
 *
 * `.strip()` (the zod default) would have been the tempting choice and is
 * subtly worse: it silently discards unknown keys, so a client sending a
 * price would get a successful checkout at the real price and no signal that
 * its parameter did nothing. Loud rejection makes the boundary observable
 * from the outside, which is what lets a test prove it.
 *
 * The one input this endpoint takes is `projectId`, from the ROUTE PATH — and
 * even that is only a lookup key. Everything else is resolved server-side by
 * `PaymentCapability` from the project's own durable state and from server
 * configuration.
 */
export const createCheckoutBodySchema = z.object({}).strict();

export type CreateCheckoutBody = z.infer<typeof createCheckoutBodySchema>;
