/**
 * Wand Performance Optimization Phase: the bounded, asset-identity-keyed
 * decoded-candidate cache. Proves the invariants its own doc comment
 * claims: get/set round-trips, LRU eviction bounds size, distinct asset
 * ids never collide, and re-caching the same id doesn't grow the map.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import {
  cacheDecodedCandidate,
  decodedCandidateCacheKeysForTests,
  getCachedDecodedCandidate,
  resetDecodedCandidateCacheForTests,
} from "./sign-wand-candidate-cache";

function tinyImage(seed: number): RgbaImage {
  return { width: 1, height: 1, data: Buffer.from([seed, seed, seed, 255]) };
}

describe("sign-wand-candidate-cache", () => {
  beforeEach(() => {
    resetDecodedCandidateCacheForTests();
  });

  it("a miss returns null", () => {
    assert.equal(getCachedDecodedCandidate("nonexistent"), null);
  });

  it("round-trips: caching an id and reading it back returns the SAME object", () => {
    const image = tinyImage(10);
    cacheDecodedCandidate("asset-a", image);
    assert.equal(getCachedDecodedCandidate("asset-a"), image);
  });

  it("different asset ids never collide", () => {
    const a = tinyImage(1);
    const b = tinyImage(2);
    cacheDecodedCandidate("asset-a", a);
    cacheDecodedCandidate("asset-b", b);
    assert.equal(getCachedDecodedCandidate("asset-a"), a);
    assert.equal(getCachedDecodedCandidate("asset-b"), b);
  });

  it("re-caching the same id replaces the entry without growing the map", () => {
    const a1 = tinyImage(1);
    const a2 = tinyImage(2);
    cacheDecodedCandidate("asset-a", a1);
    cacheDecodedCandidate("asset-a", a2);
    assert.equal(decodedCandidateCacheKeysForTests().length, 1);
    assert.equal(getCachedDecodedCandidate("asset-a"), a2);
  });

  it("evicts the LEAST recently used entry once the bound is exceeded", () => {
    // The cache's own documented ceiling is 3 entries — add a 4th and prove
    // exactly one (the least recently used) is evicted, never all of them.
    cacheDecodedCandidate("asset-1", tinyImage(1));
    cacheDecodedCandidate("asset-2", tinyImage(2));
    cacheDecodedCandidate("asset-3", tinyImage(3));
    cacheDecodedCandidate("asset-4", tinyImage(4));
    const keys = decodedCandidateCacheKeysForTests();
    assert.ok(keys.length <= 3, `cache must stay bounded, got ${keys.length} entries`);
    assert.equal(getCachedDecodedCandidate("asset-1"), null, "the oldest, never-re-touched entry must be evicted");
    assert.ok(getCachedDecodedCandidate("asset-4"), "the newest entry must survive");
  });

  it("reading an entry marks it as recently used, protecting it from the next eviction", () => {
    cacheDecodedCandidate("asset-1", tinyImage(1));
    cacheDecodedCandidate("asset-2", tinyImage(2));
    cacheDecodedCandidate("asset-3", tinyImage(3));
    // Touch asset-1 (the otherwise-oldest) so it's no longer the LRU victim.
    getCachedDecodedCandidate("asset-1");
    cacheDecodedCandidate("asset-4", tinyImage(4)); // should evict asset-2, the now-oldest untouched entry
    assert.ok(getCachedDecodedCandidate("asset-1"), "recently-touched entry must survive eviction");
    assert.equal(getCachedDecodedCandidate("asset-2"), null, "the now-least-recently-used entry is evicted instead");
  });

  it("resetDecodedCandidateCacheForTests clears every entry", () => {
    cacheDecodedCandidate("asset-1", tinyImage(1));
    resetDecodedCandidateCacheForTests();
    assert.deepEqual(decodedCandidateCacheKeysForTests(), []);
  });
});
