import { z } from "zod";

/**
 * Sprint 2M Phase 2B. Kept out of route.ts so it can be imported by tests
 * without adding extra exports to a Next.js route module (mirrors
 * `brief/decision/schema.ts`).
 *
 * `artworkVersionId` is required and explicit — the request always names
 * the exact concept the customer is approving; the server never infers
 * "whatever is currently selected" from ambient state alone (Goal 3).
 */
export const finalizeBodySchema = z.object({
  artworkVersionId: z.string().uuid(),
});

export type FinalizeBody = z.infer<typeof finalizeBodySchema>;
