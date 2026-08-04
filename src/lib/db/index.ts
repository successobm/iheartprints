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

export function getPersistenceMode(): "supabase" | "local" {
  return isSupabaseConfigured() ? "supabase" : "local";
}
