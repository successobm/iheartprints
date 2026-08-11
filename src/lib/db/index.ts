import type { ProjectRepository } from "./repository";
import { LocalProjectRepository } from "./local-store";
import { SupabaseProjectRepository } from "./supabase-store";
import { inspectSupabaseCredentials } from "./supabase-client";
import { isAutomatedTestEnvironment } from "@/lib/config/automated-test-safety";

let repository: ProjectRepository | null = null;

/**
 * Server-Only RLS Lockdown: selection is now three-way, not two-way.
 *
 * A Supabase URL with no `SUPABASE_SERVICE_ROLE_KEY` used to resolve to the
 * on-disk `LocalProjectRepository` (because `isSupabaseConfigured()` was
 * satisfied by an anon key, or by nothing at all). Under the server-only
 * data access contract that outcome is the worst of both worlds: the
 * deployment believes it is persisting customer work to Supabase while it is
 * actually writing to a local directory that the next deploy discards. It
 * now fails closed with the same error `getSupabaseServiceClient()` raises.
 *
 * Automated test runs are exempt and keep the local repository — the test
 * suite must never be able to reach real infrastructure (see
 * `automated-test-safety.ts` for the incident that rule came from).
 */
export function getProjectRepository(): ProjectRepository {
  if (repository) return repository;

  const credentials = inspectSupabaseCredentials();

  if (
    credentials === "misconfigured_missing_service_role" &&
    !isAutomatedTestEnvironment()
  ) {
    throw new Error(
      "Supabase is misconfigured: SUPABASE_SERVICE_ROLE_KEY is missing. " +
        "Refusing to fall back to the local development store while a Supabase " +
        "URL is configured — application tables are server-only and require " +
        "the service role.",
    );
  }

  repository =
    credentials === "configured"
      ? new SupabaseProjectRepository()
      : new LocalProjectRepository();

  return repository;
}

/** Test-only: drop the repository singleton so temp-dir cleanup can release it. */
export function resetProjectRepositoryForTests(): void {
  repository = null;
}

export function getPersistenceMode(): "supabase" | "local" {
  return inspectSupabaseCredentials() === "configured" ? "supabase" : "local";
}
