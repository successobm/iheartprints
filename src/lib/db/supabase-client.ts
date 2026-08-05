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
 */
export function getSupabaseServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase environment variables are not configured");
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  });
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
}
