import { z } from "zod";

/**
 * Kept out of route.ts so it can be imported by tests without adding
 * extra exports to a Next.js route module.
 *
 * Sprint 2L Phase 1B (Goal 12): "continue" removed — it transitioned to
 * `continue_requested` and asked "What else would you like the designer
 * to know?", but that phase then ran through the exact same adaptive
 * pipeline (Intent Extraction → Brief Evaluation → Interview Intelligence)
 * as "edit"'s `edit_requested` phase — the only difference was the
 * opening question's wording. A customer wanting to add more detail can
 * use Edit for that; a dedicated third button offered no distinct
 * capability. See ARCHITECTURE.md §10b.
 */
export const briefDecisionBodySchema = z.object({
  action: z.enum(["approve", "edit"]),
});

export type BriefDecisionBody = z.infer<typeof briefDecisionBodySchema>;
