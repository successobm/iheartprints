import { z } from "zod";

/**
 * Kept out of route.ts so it can be imported by tests without adding
 * extra exports to a Next.js route module.
 */
export const briefDecisionBodySchema = z.object({
  action: z.enum(["approve", "edit", "continue"]),
});

export type BriefDecisionBody = z.infer<typeof briefDecisionBodySchema>;
