import { createHash } from "node:crypto";

/**
 * Provider Intermediate Storage-Key Collision Repair — the storage-identity
 * contract for every artifact a FinalArtwork job persists through
 * `AssetCapability.uploadProductionAsset`.
 *
 * LIVE INCIDENT that forced this contract into existence (controlled
 * production acceptance of the short-bounded worker, prepared-upload job
 * `67816e21…`): a job's provider-result intermediate and its authoritative
 * production plate were both uploaded under the same `conceptId`
 * (`prepared-upload-${artworkPreparationId}`) and the same implicit
 * `production.png` filename, so `buildObjectKey` resolved both to ONE
 * physical object. Storage is create-only (`upsert: false`), so the
 * intermediate — written first, by the new download stage — permanently
 * blocked the plate, and the job died with "The resource already exists"
 * after `production_asset_upload_started`, leaving 0 authoritative
 * production assets.
 *
 * THE CONTRACT, in two rules:
 *
 *   1. SEPARATION — two artifacts that are not the SAME logical artifact
 *      must never resolve to the same physical object key. "Logical
 *      artifact" is (artifact class, logical identity).
 *
 *      The direction that matters is one-way: the key must be at least as
 *      FINE as the durable adoption check that decides whether an existing
 *      artifact may stand in for the one about to be written. Anything the
 *      adoption check treats as a genuine difference must move the key, or
 *      a write that adoption correctly refused to skip will collide with
 *      the artifact it refused. The converse is harmless and is NOT
 *      claimed: an adoption check that is deliberately coarser than the
 *      key (see `pass1_intermediate` below) simply skips a write that
 *      would have gone somewhere else anyway.
 *
 *      Per class:
 *      - `provider_result_intermediate` — the tuple is EXACTLY the data
 *        `providerResultIntermediateMatchesIdentity` plus the
 *        `providerRequestId` list filter compare, field for field. Key and
 *        adoption are the same question here.
 *      - `pass1_intermediate` — the key is FINER than adoption:
 *        `resolveExistingIntermediateReconstruction` adopts the first
 *        marker-bearing asset for the job regardless of request id, while
 *        the key separates per request. That is deliberate — a job that
 *        self-heals and submits a genuinely new pass-1 request writes a
 *        genuinely new object rather than colliding.
 *      - `final_plate` — the ONE class where rule 1 is not met literally,
 *        and the exception is stated rather than papered over. The tuple is
 *        the produced artifact's own observable identity (source,
 *        transform, provider result, produced geometry); the durable-intent
 *        loop guard additionally compares `productionWidthIn` and
 *        `confirmedMaxHeightIn`, which the key omits. In every reachable
 *        case that gap costs nothing: an envelope change that actually
 *        binds moves the produced geometry and therefore the key, and one
 *        that does NOT bind leaves the effective target unchanged, so
 *        `resolveExistingProductionAsset` adopts the existing plate and no
 *        upload is attempted at all. The residual case — a geometry
 *        PREDICTION drift large enough to make that adoption miss, combined
 *        with a non-binding envelope change — lands two plates on one key,
 *        and is survivable rather than fatal only because both carry
 *        byte-identical pixels (same immutable source, same resolved
 *        sizing), so `uploadStorageWithSelfHealAndBoundedRetry` adopts the
 *        object already there. The cost is a duplicate asset ROW over one
 *        object, never a failed job and never a wrong deliverable. Widening
 *        the tuple to close it is a deliberate future change: it would move
 *        every plate key, so it needs its own decision and its own
 *        migration story for in-flight jobs.
 *
 *   2. DETERMINISM — the key is a pure function of that pair. No clock, no
 *      randomness, no attempt counter, no insertion order. A retry of the
 *      SAME logical artifact therefore recomputes the SAME key, which is
 *      exactly what keeps `uploadStorageWithSelfHealAndBoundedRetry`'s
 *      "did my own prior attempt's bytes already land here?" self-heal
 *      meaningful and keeps every crash-resume idempotent.
 *
 * Deliberately NOT solved by `upsert: true`, deleting or overwriting an
 * intermediate before the final upload, randomized filenames, or
 * suppressing the collision error: every historical durable intermediate
 * stays exactly where it is, byte-identical, as the audit evidence for a
 * paid provider request that it is (Constitution §6.11, Version
 * Everything). Separation, never destruction.
 *
 * The grouping folder is unchanged — a job's artifacts still live together
 * under one stable internal grouping id. What this adds is the artifact
 * CLASS and IDENTITY, inside the file stem, where `buildObjectKey` can see
 * it.
 */

/**
 * The semantically distinct artifact classes a FinalArtwork job can
 * persist. Each is a genuinely different thing with a different lifetime
 * and a different audience, never three views of one object:
 *
 * - `pass1_intermediate` — a two-pass reconstruction's PASS 1 output.
 *   Internal; another paid provider submission is still coming.
 * - `provider_result_intermediate` — the LAST provider pass's raw
 *   downloaded result. Internal; no further provider contact is needed,
 *   only local normalize/measure/upload.
 * - `final_plate` — the authoritative, customer-facing production
 *   deliverable that Print Validation judges.
 *
 * These mirror the two metadata stage markers in
 * `production-request-identity.ts` plus "neither marker" for the plate.
 * Kept as its own enum rather than reusing the marker strings so a storage
 * path never silently changes shape if a marker string is ever reworded.
 */
export type ProductionArtifactClass =
  | "pass1_intermediate"
  | "provider_result_intermediate"
  | "final_plate";

const CLASS_SLUG: Record<ProductionArtifactClass, string> = {
  pass1_intermediate: "pass1-intermediate",
  provider_result_intermediate: "provider-result-intermediate",
  final_plate: "production",
};

/**
 * A field of an artifact's logical identity. `null`/`undefined` are
 * meaningful values (an absent `confirmedMaxHeightIn` is a real, distinct
 * production intent from a present one) and are encoded distinguishably —
 * never collapsed together, and never collapsed into the empty string.
 */
export type ProductionArtifactIdentityField = unknown;

/**
 * 12 hex characters (48 bits) of SHA-256. Long enough that an accidental
 * collision between two identity tuples within one project's grouping
 * folder is not a practical concern, short enough that an operator reading
 * a storage listing can still tell the classes apart at a glance. Never
 * truncated further: the whole point of this repair is that two different
 * artifacts cannot alias.
 */
const IDENTITY_DIGEST_LENGTH = 12;

/**
 * One identity field, encoded so that CONCATENATING the encoded fields is
 * injective: distinct tuples can never produce the same encoded string, and
 * therefore can never produce the same digest or alias one storage object.
 *
 * Two properties do that, and both are load-bearing:
 *
 *   1. A TYPE TAG, so values that merely print the same are still
 *      different: an absent `confirmedMaxHeightIn` (`null`) versus the
 *      literal string `"null"`, or the number `10.5` versus the string
 *      `"10.5"`.
 *   2. A LENGTH PREFIX, so a field's own CONTENT can never be mistaken for
 *      a field boundary. A bare separator character is not enough, however
 *      exotic it looks: any separator that can appear inside a value can be
 *      smuggled into one, and `["a", "b"]` would then encode identically to
 *      a single field containing the separator. A length prefix has no such
 *      hole, needs no assumption about what an identity value may contain,
 *      and — unlike a raw control byte — keeps every executable line and
 *      every encoding literal here ordinary printable text, so git and
 *      ripgrep treat this module as the reviewable source it needs to be
 *      rather than as a binary blob.
 *
 * Injective over JS strings, which is the level every real identity field
 * lives at. Two caveats, both unreachable today and recorded so a future
 * field type does not inherit a guarantee that was never made: the digest
 * consumes UTF-8, so a LONE SURROGATE and U+FFFD hash alike (every live
 * field is a UUID, a hard-coded provider/method constant, a SHA-256 hex
 * string or a finite number, and the one `unknown` — `sourceBytesSha256` —
 * comes back out of Postgres `jsonb`, which rejects lone surrogates
 * outright); and `-0` and `0` both stringify to `n:0`.
 *
 * `GOLDEN_PRODUCTION_ARTIFACT_STEMS` below pins the resulting keys against
 * literal expected values, because a silent change here is uniquely
 * dangerous: nothing would throw, no self-consistency or distinctness test
 * would fail, and yet every object already written would become unfindable.
 */
function encodeIdentityField(field: ProductionArtifactIdentityField): string {
  const payload = identityFieldPayload(field);
  return `${payload.length}:${payload}`;
}

function identityFieldPayload(field: ProductionArtifactIdentityField): string {
  if (field === null) return "null";
  if (field === undefined) return "undefined";
  if (typeof field === "number") return `n:${field}`;
  if (typeof field === "boolean") return `b:${field}`;
  if (typeof field === "string") return `s:${field}`;
  // Independent-review finding: `sourceBytesSha256` reaches this module
  // typed `unknown` (it is read back out of a metadata bag). Coercing every
  // non-primitive to `null` would make the KEY coarser than the adoption
  // check that compares those same values, so two identities the check
  // calls different could share one object. Encoding the value faithfully
  // keeps key-equality no coarser than adoption-equality, which is the
  // direction that matters.
  try {
    return `j:${JSON.stringify(field) ?? "undefined"}`;
  } catch {
    // A circular or otherwise unserializable value cannot be given an
    // honest identity, and silently aliasing every such value with every
    // other is exactly the failure this module exists to prevent.
    throw new Error(
      "productionArtifactStorageFileStem: identity field is not serializable, so it cannot be given a stable storage identity",
    );
  }
}

/**
 * The file stem (no extension) for one logical production artifact —
 * `AssetCapability.uploadProductionAsset` appends the content type's own
 * extension, exactly as it always did.
 *
 * `identity` is the artifact class's own adoption tuple, in a FIXED order
 * chosen by the call site. Order is part of the identity: callers pass a
 * literal tuple, never a set or an object iterated in unspecified order,
 * so the digest can never depend on how a record happened to be built.
 *
 * The `final_plate` class keeps the historical `production` stem prefix so
 * a storage listing still reads the way an operator expects and the
 * customer's deliverable stays the obvious one; it gains the identity
 * digest for the same reason the intermediates do — a job whose confirmed
 * production envelope changes underneath it produces a genuinely DIFFERENT
 * plate, which must not be blocked by (or silently alias) the plate made
 * for the old envelope.
 */
export function productionArtifactStorageFileStem(input: {
  artifactClass: ProductionArtifactClass;
  identity: readonly ProductionArtifactIdentityField[];
}): string {
  const digest = createHash("sha256")
    .update(input.artifactClass)
    .update(input.identity.map(encodeIdentityField).join(""))
    .digest("hex")
    .slice(0, IDENTITY_DIGEST_LENGTH);
  return `${CLASS_SLUG[input.artifactClass]}-${digest}`;
}

/**
 * The GOLDEN stems — the literal values this encoding produces today, for
 * three fixed inputs covering every branch of `encodeIdentityField`.
 *
 * These exist because a silent change to this function is uniquely
 * dangerous and uniquely hard to notice: nothing throws, no test of
 * self-consistency or pairwise distinctness fails, and yet every
 * already-written object becomes unfindable. A job that crashed between
 * its storage write and its `createAsset` row would recompute a DIFFERENT
 * key on resume, `uploadStorageWithSelfHealAndBoundedRetry` would never
 * find its own prior bytes, and the earlier object would be orphaned with
 * no cleanup path able to reach it.
 *
 * If a change to this module makes these fail, that is the intended
 * signal, not a stale fixture: changing an artifact's storage identity
 * strands every object already written under the old one, and needs a
 * deliberate decision (and a migration story for in-flight jobs), never a
 * fixture update.
 */
export const GOLDEN_PRODUCTION_ARTIFACT_STEMS: ReadonlyArray<{
  artifactClass: ProductionArtifactClass;
  identity: readonly ProductionArtifactIdentityField[];
  stem: string;
}> = [
  {
    artifactClass: "final_plate",
    identity: ["asset-1", "topaz_transparency_upscale_v1", "request-a", 3150, 3138],
    stem: "production-344aea90f766",
  },
  {
    artifactClass: "provider_result_intermediate",
    identity: ["request-a", "topaz_transparency_upscale", "asset-1", "sha-1", 10.5, null],
    stem: "provider-result-intermediate-f3d42f1ddad9",
  },
  {
    artifactClass: "pass1_intermediate",
    identity: ["topaz_transparency_upscale", "request-a", true, undefined],
    stem: "pass1-intermediate-17114edb6d26",
  },
];
