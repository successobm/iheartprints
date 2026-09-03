/**
 * Wand Performance Optimization Phase: a small, bounded, in-process cache
 * for the DECODED production-candidate pixel buffer — the single dominant
 * cost this phase's own profiling found (candidate resolution ~962ms +
 * storage download ~895ms + preparation lookup ~675ms + PNG decode
 * ~1123ms ≈ 3.6s, repeated on EVERY wand click against a real ~20.7MP
 * candidate, while the flood-fill itself is only 10-311ms).
 *
 * SAFETY INVARIANT (why this is safe to share across requests/callers):
 * keyed EXCLUSIVELY by the asset's own immutable id, never by project id
 * and never treated as "the current candidate for this project." Signs
 * production assets are immutable once created (Constitution: never
 * overwrite a candidate) — the pixel bytes behind a given `assetId` can
 * never change, so a cached decode for that id is correct forever; there
 * is no staleness question to answer for THIS cache. WHICH asset id is
 * currently the project's blocked candidate is a genuinely time-varying
 * fact and is deliberately NEVER cached here or anywhere in this phase —
 * every caller must still resolve that fresh, every time (see
 * `resolveCurrentCandidateImage` in `sign-artwork-service.ts`, unchanged
 * in this respect). A new candidate simply has a new, not-yet-cached
 * asset id; the old cached entry for the superseded id becomes merely
 * unreferenced, never wrong, and is reclaimed by ordinary LRU eviction —
 * no explicit invalidation hook is needed or provided.
 *
 * Never mutated by any consumer: `floodFillSelect` only reads pixel
 * bytes, and every correction primitive (`applyCorrectionsToCanvas` and
 * friends) builds a fresh `Buffer.from(candidate.data)` copy before
 * writing anything — the cached `RgbaImage` itself is never written to,
 * so sharing the same object across concurrent requests is safe.
 *
 * Bounded: a small LRU (default 3 entries) — enough to cover an operator
 * actively working one sign, having just glanced at another, without
 * unbounded growth. At ~83MB per decoded 20.7MP candidate, 3 entries is a
 * deliberately modest ceiling (~250MB worst case), not an unbounded
 * server-side image store. No Redis, no external infrastructure — a
 * plain in-process Map, exactly Section I's own stated ceiling.
 */

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";

const MAX_CACHED_DECODED_CANDIDATES = 3;

const decodedCandidateCache = new Map<string, RgbaImage>();

/** `null` on a cache miss — the caller downloads+decodes fresh and calls `cacheDecodedCandidate`. */
export function getCachedDecodedCandidate(assetId: string): RgbaImage | null {
  const image = decodedCandidateCache.get(assetId);
  if (!image) return null;
  // Touch for LRU recency: Map iteration/insertion order is preserved, so
  // delete+re-set moves this entry to the most-recently-used end.
  decodedCandidateCache.delete(assetId);
  decodedCandidateCache.set(assetId, image);
  return image;
}

export function cacheDecodedCandidate(assetId: string, image: RgbaImage): void {
  decodedCandidateCache.delete(assetId); // avoid a stale position if already present
  decodedCandidateCache.set(assetId, image);
  while (decodedCandidateCache.size > MAX_CACHED_DECODED_CANDIDATES) {
    const oldestKey = decodedCandidateCache.keys().next().value;
    if (oldestKey === undefined) break;
    decodedCandidateCache.delete(oldestKey);
  }
}

/** Test-only: guarantees each test starts with a clean, deterministic cache state. */
export function resetDecodedCandidateCacheForTests(): void {
  decodedCandidateCache.clear();
}

/** Test-only: observability into cache size/membership without exposing the pixel data itself. */
export function decodedCandidateCacheKeysForTests(): string[] {
  return [...decodedCandidateCache.keys()];
}
