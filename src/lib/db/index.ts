import type { ProjectRepository } from "./repository";
import { LocalProjectRepository } from "./local-store";
import {
  isSupabaseConfigured,
  SupabaseProjectRepository,
} from "./supabase-store";

let repository: ProjectRepository | null = null;

export function getProjectRepository(): ProjectRepository {
  if (repository) return repository;

  if (isSupabaseConfigured()) {
    repository = new SupabaseProjectRepository();
  } else {
    repository = new LocalProjectRepository();
  }

  return repository;
}

/** Test-only: drop the repository singleton so temp-dir cleanup can release it. */
export function resetProjectRepositoryForTests(): void {
  repository = null;
}

export function getPersistenceMode(): "supabase" | "local" {
  return isSupabaseConfigured() ? "supabase" : "local";
}
