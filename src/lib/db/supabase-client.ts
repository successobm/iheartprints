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
 * Every application table in the public schema has RLS enabled with NO
 * policies, and anon/authenticated hold no table privileges — the data
 * access contract is "server, service role, only" (see `ARCHITECTURE.md`,
 * Current Data Access Model). Under that contract an anon-keyed client is
 * not a degraded-but-working repository, it is a repository on which every
 * single query fails closed. Silently constructing one would turn a
 * missing-credential deployment mistake into a flood of confusing runtime
 * data errors instead of one clear configuration failure at the boundary.
 *
 * The local/offline development story is unchanged and deliberate: with
 * NEITHER variable set, `getProjectRepository()` still selects
 * `LocalProjectRepository`. What is now refused is the in-between state —
 * a Supabase URL configured with no service-role key — because that is
 * production asking to run on credentials that cannot read its own data.
 */
const SUPABASE_URL_ENV_VAR = "NEXT_PUBLIC_SUPABASE_URL";
const SERVICE_ROLE_ENV_VAR = "SUPABASE_SERVICE_ROLE_KEY";

/**
 * The three legitimate states of this process's Supabase credentials.
 *
 * `misconfigured_missing_service_role` is called out as its own state
 * rather than being folded into "unconfigured" precisely so the caller can
 * fail loudly instead of quietly demoting a Supabase-backed deployment to
 * the on-disk local store.
 */
export type SupabaseCredentialState =
  | "configured"
  | "unconfigured"
  | "misconfigured_missing_service_role";

/**
 * Pure so it can be exhaustively tested without mutating `process.env`
 * (the same reasoning as `resolveAssetStorageProvider`'s explicit-mode
 * parameter).
 */
export function inspectSupabaseCredentials(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseCredentialState {
  const url = env[SUPABASE_URL_ENV_VAR]?.trim();
  const serviceRoleKey = env[SERVICE_ROLE_ENV_VAR]?.trim();

  if (url && serviceRoleKey) return "configured";
  if (url) return "misconfigured_missing_service_role";
  return "unconfigured";
}

/**
 * Never falls back to the anon/publishable key. Callers get a privileged
 * client or an explicit error — never a silently under-privileged one.
 *
 * The thrown errors name the missing VARIABLE only. No credential value,
 * partial value, or length is ever included.
 */
export function getSupabaseServiceClient(): SupabaseClient {
  const url = process.env[SUPABASE_URL_ENV_VAR]?.trim();
  const key = process.env[SERVICE_ROLE_ENV_VAR]?.trim();

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

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  });
}

export function isSupabaseConfigured(): boolean {
  return inspectSupabaseCredentials() === "configured";
}
