import { z } from "zod";

import { MAX_EMAIL_LENGTH } from "@/capabilities/acquisition";

/**
 * Sprint A4: a deliberately thin transport schema. It bounds the payload so
 * an absurd body is rejected before it reaches application code, and does
 * NOT try to be the email validator — that lives in
 * `capabilities/acquisition/acquisition-email.ts`, where it is pure,
 * directly unit-testable, and shared with anything else that ever needs it.
 *
 * Two validators disagreeing about what an address is would be a real bug,
 * so there is only one, and this is not it.
 */
export const captureEmailBodySchema = z.object({
  email: z.string().max(MAX_EMAIL_LENGTH),
});
