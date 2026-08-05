/**
 * Sprint 2H Part 1B: provider-neutral configuration for where generated
 * asset *bytes* live. Separate from `AssetCapability` (which persists
 * `AssetRecord` metadata — see asset-capability.ts) — this module only
 * decides which storage backend `storageKey` is allowed to point at.
 *
 * `data_uri` embeds bytes directly inside `storageKey` itself (a
 * `data:image/...;base64,...` string) and is stored inline in whatever
 * `ProjectRepository` persists to (local JSON store or Postgres row).
 * Acceptable for local development, automated tests, placeholder concepts,
 * and architecture verification. Not acceptable for real production images:
 * it inflates database rows, API responses, snapshots, backups, memory
 * usage, and local-store writes.
 *
 * Sprint 2H Part 2A: `filesystem` and `supabase_storage` are now real,
 * implemented backends (`FilesystemAssetStorageProvider`,
 * `SupabaseStorageAssetProvider` — see `capabilities/asset-storage/`).
 * `filesystem` writes to local disk and mirrors Supabase Storage's
 * bucket/object-key/signed-URL semantics for local dev and tests without
 * needing real cloud infrastructure — like `data_uri`, it is NOT
 * production-safe (disk on a container is not durable object storage).
 * `s3` remains reserved-but-unimplemented (see
 * `resolveAssetStorageProvider`) — its `isProductionSafeAssetStorageMode`
 * answer is aspirational until an adapter exists, matching how this module
 * already treated `supabase_storage` before Part 2A implemented it.
 *
 * Pure and side-effect-free, mirroring `generation-provider-config.ts` —
 * no logging here, trivially testable.
 */

export type AssetStorageMode =
  | "data_uri"
  | "filesystem"
  | "supabase_storage"
  | "s3";

const DEFAULT_ASSET_STORAGE_MODE: AssetStorageMode = "data_uri";

export function getAssetStorageMode(): AssetStorageMode {
  const requested = (process.env.ASSET_STORAGE_MODE ?? DEFAULT_ASSET_STORAGE_MODE)
    .trim()
    .toLowerCase();

  if (requested === "filesystem") return "filesystem";
  if (requested === "supabase_storage") return "supabase_storage";
  if (requested === "s3") return "s3";
  // Unrecognized values fall back to the safe, always-implemented default
  // rather than throwing — same tolerance as
  // `getConceptGenerationConfig`'s unrecognized-provider fallback.
  return "data_uri";
}

/**
 * Production-safe: real, durable object storage — not bytes embedded in a
 * database row (`data_uri`) and not local container disk (`filesystem`),
 * neither of which survives a redeploy or scales across instances.
 */
export function isProductionSafeAssetStorageMode(mode: AssetStorageMode): boolean {
  return mode === "supabase_storage" || mode === "s3";
}
