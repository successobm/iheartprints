/**
 * Phase 28M.1: the pure decision behind `page.tsx`'s render branch --
 * extracted so it is directly unit-testable, matching this repo's existing
 * habit for exactly this reason (see `computeSeparationCheckStatus` in
 * `SeparationReviewPanel.tsx`, whose own doc comment explains why: this
 * repo's test tooling is `node:test` + `renderToString`, no DOM, no
 * effects, and no Next.js request context for a Server Component's
 * `cookies()` call -- so the actual branch LOGIC lives here, in a function
 * with no framework dependency at all.
 */
export type InternalAccessPageState = "unconfigured" | "already_internal" | "needs_key";

export function resolveInternalAccessPageState(input: {
  configured: boolean;
  alreadyInternal: boolean;
}): InternalAccessPageState {
  if (!input.configured) return "unconfigured";
  if (input.alreadyInternal) return "already_internal";
  return "needs_key";
}
