import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import WebSocket from "ws";

/**
 * Sprint 2H Part 2A: factored out of `supabase-store.ts` so
 * `SupabaseStorageAssetProvider` (Storage API) and `SupabaseProjectRepository`
 * (Postgres tables) share one client-construction path instead of each
 * reading the same environment variables independently.
 *
 * `@supabase/supabase-js` eagerly constructs a Realtime client (even though
 * this codebase only ever uses Postgres tables and Storage, never realtime
 * subscriptions), which requires a WebSocket constructor on Node < 22. The
 * `ws` package supplies one — without it, `createClient` throws on any
 * Node version we currently run on.
 *
 * ---
 *
 * Server-Only RLS Lockdown: this module previously fell back to
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` when `SUPABASE_SERVICE_ROLE_KEY` was
 * absent. That fallback is now removed, and its removal is load-bearing.
 *
 * Presence of the *variable named* `SUPABASE_SERVICE_ROLE_KEY` is also not
 * enough. Postgres role comes from the JWT `role` claim (or the new
 * `sb_secret_` / `sb_publishable_` key prefix), not from the environment
 * variable's name. A correctly named variable holding the anon/publishable
 * secret authenticates as `anon`, and every application table then fails
 * with `42501 permission denied` — the production incident this check
 * closes. The factory therefore inspects authority and refuses anything
 * other than `service_role`.
 *
 * Every application table in the public schema has RLS enabled with NO
 * policies, and anon/authenticated hold no table privileges — the data
 * access contract is "server, service role, only" (see `ARCHITECTURE.md`,
 * Current Data Access Model). Under that contract an anon-keyed client is
 * not a degraded-but-working repository, it is a repository on which every
 * single query fails closed. Silently constructing one would turn a
 * missing-or-wrong-credential deployment mistake into a flood of confusing
 * runtime data errors instead of one clear configuration failure at the
 * boundary.
 *
 * The local/offline development story is unchanged and deliberate: with
 * NEITHER variable set, `getProjectRepository()` still selects
 * `LocalProjectRepository`. What is now refused is the in-between state —
 * a Supabase URL configured with no service-role key, or with a key that
 * does not actually carry service-role authority — because that is
 * production asking to run on credentials that cannot read its own data.
 *
 * `getSupabaseServiceClient` reads `process.env.NEXT_PUBLIC_SUPABASE_URL`
 * and `process.env.SUPABASE_SERVICE_ROLE_KEY` as static identifiers so
 * Next.js production bundling includes those server env vars. Dynamic
 * `process.env[name]` lookups are not a reliable Next.js env boundary.
 */
const SUPABASE_URL_ENV_VAR = "NEXT_PUBLIC_SUPABASE_URL";
const SERVICE_ROLE_ENV_VAR = "SUPABASE_SERVICE_ROLE_KEY";

/**
 * The legitimate states of this process's Supabase credentials.
 *
 * `misconfigured_missing_service_role` and `misconfigured_wrong_authority`
 * are called out as their own states rather than being folded into
 * "unconfigured" precisely so the caller can fail loudly instead of quietly
 * demoting a Supabase-backed deployment to the on-disk local store.
 */
export type SupabaseCredentialState =
  | "configured"
  | "unconfigured"
  | "misconfigured_missing_service_role"
  | "misconfigured_wrong_authority";

/**
 * Database authority implied by a Supabase key. `service_role` is the only
 * acceptable repository/storage credential under the current server-only
 * data access model. Labels other than the key value itself may appear in
 * errors; the secret is never logged.
 */
export type SupabaseKeyAuthority =
  | "service_role"
  | "anon"
  | "authenticated"
  | "publishable"
  | "unrecognized";

/**
 * Pure so it can be exhaustively tested without mutating `process.env`
 * (the same reasoning as `resolveAssetStorageProvider`'s explicit-mode
 * parameter).
 */
export function inspectSupabaseCredentials(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseCredentialState {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (url && serviceRoleKey) {
    return inspectSupabaseKeyAuthority(serviceRoleKey) === "service_role"
      ? "configured"
      : "misconfigured_wrong_authority";
  }
  if (url) return "misconfigured_missing_service_role";
  return "unconfigured";
}

/**
 * Derives the Postgres/Data-API role a key will authenticate as.
 * Never returns or logs the key. Unsigned JWT payload decode only — the
 * signature is validated by Supabase, not by us; we only refuse to *send*
 * a present-but-underprivileged secret as if it were the service role.
 */
export function inspectSupabaseKeyAuthority(key: string): SupabaseKeyAuthority {
  const trimmed = key.trim();
  if (!trimmed) return "unrecognized";
  if (trimmed.startsWith("sb_secret_")) return "service_role";
  if (trimmed.startsWith("sb_publishable_")) return "publishable";

  const role = readJwtRoleClaim(trimmed);
  if (role === "service_role") return "service_role";
  if (role === "anon") return "anon";
  if (role === "authenticated") return "authenticated";
  return "unrecognized";
}

function readJwtRoleClaim(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const json = decodeJwtPayload(parts[1]);
    return typeof json.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(segment: string): { role?: unknown } {
  const padded =
    segment.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {
    role?: unknown;
  };
}

function wrongAuthorityMessage(authority: SupabaseKeyAuthority): string {
  return (
    `Supabase is misconfigured: ${SERVICE_ROLE_ENV_VAR} does not have service_role ` +
    `authority (observed: ${authority}). Application tables are server-only ` +
    "(RLS enabled, no anon/authenticated privileges), so a browser-facing " +
    "key cannot be used as the server repository credential."
  );
}

/**
 * Never falls back to the anon/publishable key. Callers get a privileged
 * client or an explicit error — never a silently under-privileged one.
 *
 * The thrown errors name the missing VARIABLE and, when a key is present
 * but underprivileged, the observed authority label. No credential value,
 * partial value, or length is ever included.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  // Static identifiers: Next.js inlines/includes these server env vars
  // only when referenced as `process.env.EXACT_NAME`.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url) {
    throw new Error(
      `Supabase is not configured: ${SUPABASE_URL_ENV_VAR} is missing.`,
    );
  }

  if (!key) {
    throw new Error(
      `Supabase is misconfigured: ${SERVICE_ROLE_ENV_VAR} is missing. ` +
        "Application tables are server-only (RLS enabled, no anon/authenticated " +
        "privileges), so there is no anon-key fallback — configure the service " +
        "role key.",
    );
  }

  const authority = inspectSupabaseKeyAuthority(key);
  if (authority !== "service_role") {
    throw new Error(wrongAuthorityMessage(authority));
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  });
}

export function isSupabaseConfigured(): boolean {
  return inspectSupabaseCredentials() === "configured";
}
