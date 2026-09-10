import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveArtworkFidelityContractKey } from "./artwork-fidelity-contract-identity";

/**
 * Universal Raster Reconstruction Phase R3B: `deriveArtworkFidelityContractKey`
 * regression coverage — mirrors `sign-preparation`'s own `computeSignPlanKey`
 * test discipline (determinism, stability across cosmetic ordering,
 * sensitivity to exactly the production-significant fields, and nothing
 * else).
 */
function baseIdentity() {
  return {
    sourceAssetId: "asset-1",
    sourceSha256: "a".repeat(64),
    confirmedWording: ["ESTABLISHED PROVISIONS"],
    confirmedMarks: ["™" as const],
    sourceContentBoundingBoxAspectRatio: 3.7366,
  };
}

describe("deriveArtworkFidelityContractKey", () => {
  it("11: is deterministic — the same input always produces the same key", () => {
    const input = baseIdentity();
    assert.equal(
      deriveArtworkFidelityContractKey(input),
      deriveArtworkFidelityContractKey(input),
    );
  });

  it("12: is stable across non-semantic field ordering (array order of equal content)", () => {
    const a = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedWording: ["ONE", "TWO"],
      confirmedMarks: ["™", "®"],
    });
    const b = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedWording: ["TWO", "ONE"],
      confirmedMarks: ["®", "™"],
    });
    assert.equal(a, b);
  });

  it("13: a wording change changes the contract key — PROVISIONS != PRODUCTS at the key level", () => {
    const provisions = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedWording: ["ESTABLISHED PROVISIONS"],
    });
    const products = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedWording: ["ESTABLISHED PRODUCTS"],
    });
    assert.notEqual(provisions, products);
  });

  it("14: a protected-mark change changes the contract key — TM != R at the key level", () => {
    const tm = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedMarks: ["™"],
    });
    const r = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedMarks: ["®"],
    });
    assert.notEqual(tm, r);
  });

  it("15: timestamps play no role — the pure function accepts none, so there is nothing that could change the key", () => {
    // Structural proof: ArtworkFidelityContractIdentityInput has no
    // createdAt/updatedAt/confirmedAt field at all — the type itself makes
    // this untestable-as-a-regression any other way. Two calls, no
    // timestamp field passed either time, same result.
    const input = baseIdentity();
    const first = deriveArtworkFidelityContractKey(input);
    const second = deriveArtworkFidelityContractKey({ ...input });
    assert.equal(first, second);
  });

  it("16: source binding participates — a different sourceAssetId or sourceSha256 changes the key", () => {
    const original = deriveArtworkFidelityContractKey(baseIdentity());
    const differentAsset = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      sourceAssetId: "asset-2",
    });
    const differentSha = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      sourceSha256: "b".repeat(64),
    });
    assert.notEqual(original, differentAsset);
    assert.notEqual(original, differentSha);
  });

  it("17: only the fields ArtworkFidelityContractIdentityInput declares can participate — no model-confidence/transient field exists on the type to accidentally include", () => {
    // Structural proof, not a runtime one: the identity input type is a
    // narrow `Pick<...>` over exactly five fields (sourceAssetId,
    // sourceSha256, confirmedWording, confirmedMarks,
    // sourceContentBoundingBoxAspectRatio). There is no `proposedFacts`,
    // no `status`, no `id`, no `projectId`, no confidence score anywhere
    // in the type a caller could pass through. Demonstrate the aspect
    // ratio's OWN small-precision noise is rounded away rather than
    // leaking transient floating-point differences into the key.
    const a = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      sourceContentBoundingBoxAspectRatio: 3.73659999,
    });
    const b = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      sourceContentBoundingBoxAspectRatio: 3.73660001,
    });
    assert.equal(a, b, "sub-precision floating-point noise must not change the key");
  });

  it("null confirmedWording/confirmedMarks/aspect-ratio produce a stable, distinct key from populated ones", () => {
    const empty = deriveArtworkFidelityContractKey({
      sourceAssetId: "asset-1",
      sourceSha256: "a".repeat(64),
      confirmedWording: null,
      confirmedMarks: null,
      sourceContentBoundingBoxAspectRatio: null,
    });
    const populated = deriveArtworkFidelityContractKey(baseIdentity());
    assert.notEqual(empty, populated);
    // Determinism holds for the null case too.
    assert.equal(
      empty,
      deriveArtworkFidelityContractKey({
        sourceAssetId: "asset-1",
        sourceSha256: "a".repeat(64),
        confirmedWording: null,
        confirmedMarks: null,
        sourceContentBoundingBoxAspectRatio: null,
      }),
    );
  });

  it("an empty confirmed array is distinct from a null one (explicit 'confirmed: none' vs 'never confirmed')", () => {
    const neverConfirmed = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedWording: null,
    });
    const explicitlyNone = deriveArtworkFidelityContractKey({
      ...baseIdentity(),
      confirmedWording: [],
    });
    assert.notEqual(neverConfirmed, explicitlyNone);
  });

  it("the schema version is embedded as a stable prefix", () => {
    const key = deriveArtworkFidelityContractKey(baseIdentity());
    assert.match(key, /^artwork-fidelity-contract:v1:[0-9a-f]{64}$/);
  });
});
