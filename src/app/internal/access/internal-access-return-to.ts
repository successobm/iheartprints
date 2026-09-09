/**
 * Production Operator Access Blocker fix: where "Get internal access"
 * should send the operator back to once they authenticate.
 *
 * Before this fix, `InternalAccessForm` always navigated to `/` on success
 * — an operator who followed a "Get internal access" link from
 * `/internal/projects/[projectId]/sign-authorize` lost their place and had
 * to re-navigate to the exact project by hand. This is that return trip,
 * built the same way this codebase already builds every other narrow,
 * server-validated redirect target: a pure function, unit-testable with no
 * DOM and no Next.js request context (mirrors `resolveInternalAccessPageState`
 * in this same directory).
 *
 * SECURITY: `returnTo` arrives as an ordinary, attacker-controllable query
 * parameter — nothing stops anyone from crafting
 * `/internal/access?returnTo=https://evil.example`. This function is the
 * ONE place that value is ever trusted, and it accepts only a same-origin,
 * root-relative path:
 *
 *   - must be a single string (a repeated `?returnTo=` query param arrives
 *     as an array — rejected outright, never "pick the first/last one")
 *   - must start with exactly one `/` — rejects a bare relative path
 *     (`evil.example`, which a `<Link>`/`router.push` would resolve against
 *     the CURRENT page, not necessarily where intended) and an empty string
 *   - must NOT start with `//` or `/\` — both are browser-parsed as
 *     protocol-relative, i.e. `//evil.example` navigates off-origin exactly
 *     like `https://evil.example` would
 *   - must NOT contain `://` anywhere — defends against a path segment
 *     smuggling a second scheme (`/redirect:https://evil.example`)
 *
 * Anything that fails any check falls back to `/` — the same destination
 * this flow always used before this fix — never an error, never a 400:
 * the internal-access flow's own job (authenticate this browser) still
 * completes either way, this only decides where it lands afterward.
 */
export function resolveInternalAccessReturnTo(
  raw: string | string[] | undefined,
): string {
  if (typeof raw !== "string") return "/";
  if (raw.length === 0) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.includes("://")) return "/";
  return raw;
}
