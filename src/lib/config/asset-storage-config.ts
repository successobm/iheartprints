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
 * `supabase_storage` and `s3` name the production-safe replacements this
 * config contract is designed for. Neither is implemented yet — no bytes
 * are ever written to either backend by this codebase today. Selecting one
 * only changes what `isProductionSafeAssetStorageMode` reports; wiring a
 * real backend behind it is Sprint 2H Part 2A's job (see
 * `IHEARTPRINTS_CONSTITUTION.md` §6.11 — prior versions/data must never be
 * silently discarded, so that migration must be deliberate, not implied by
 * flipping this flag).
 *
 * Pure and side-effect-free, mirroring `generation-provider-config.ts` —
 * no logging here, trivially testable.
 */

export type AssetStorageMode = "data_uri" | "supabase_storage" | "s3";

const DEFAULT_ASSET_STORAGE_MODE: AssetStorageMode = "data_uri";

export function getAssetStorageMode(): AssetStorageMode {
  const requested = (process.env.ASSET_STORAGE_MODE ?? DEFAULT_ASSET_STORAGE_MODE)
    .trim()
    .toLowerCase();

  if (requested === "supabase_storage") return "supabase_storage";
  if (requested === "s3") return "s3";
  // Unrecognized values fall back to the safe, always-implemented default
  // rather than throwing — same tolerance as
  // `getConceptGenerationConfig`'s unrecognized-provider fallback.
  return "data_uri";
}

/**
 * Production-safe: real object storage, not bytes embedded in a database
 * row. Only `data_uri` is unsafe — every other declared mode is treated as
 * a real object-storage backend by contract, even before it has an actual
 * implementation (see module doc).
 */
export function isProductionSafeAssetStorageMode(mode: AssetStorageMode): boolean {
  return mode !== "data_uri";
}
