/**
 * Asset management boundary — uploads, references, generated files.
 * Sprint 2H Part 1: backed by real repository persistence instead of a
 * no-op stub. Sprint 2H Part 2A: bytes are now actually uploaded through a
 * configured `AssetStorageProvider` (data URI, local filesystem, or
 * Supabase Storage) and a real thumbnail is generated — this capability is
 * the ONLY thing that knows a storage backend or thumbnail generator
 * exists; the rest of the codebase (including `ConceptGenerationCapability`
 * and every provider adapter) only ever sees `AssetRecord`s.
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type { AssetKind, AssetRecord, ProductionAssetRole } from "@/lib/domain/types";
import {
  buildObjectKey,
  DataUriAssetStorageProvider,
  type AssetStorageProvider,
} from "@/capabilities/asset-storage";
import { asPaidImagePersistenceError } from "@/capabilities/shared/paid-image-failure";
import {
  boundedErrorDescription,
  describeOperationError,
  withOperationTiming as sharedWithOperationTiming,
} from "@/capabilities/shared/safe-error-description";
import type { ThumbnailGenerator } from "./thumbnail-generator";

/** Thin partial application — this module's own fixed log prefix, so every call site below stays a plain 2-arg call. */
function withOperationTiming<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return sharedWithOperationTiming("assets", label, fn);
}

/**
 * Production Asset Storage Correction Phase (real Signs acceptance
 * incident): historical-representation-aware reads. `ASSET_STORAGE_MODE`
 * decides what NEW uploads use, but a `storageKey` already persisted under a
 * DIFFERENT mode (most concretely: this real environment's own history of
 * `data_uri` rows, before this phase switched the configured default to
 * `supabase_storage`) must remain readable forever — the active provider is
 * never consulted for a key whose OWN representation is self-describing. A
 * data URI carries its bytes inline (see `DataUriAssetStorageProvider`'s own
 * doc) and needs no provider round-trip to read; this fallback instance is
 * stateless and provider-neutral, so using it here — regardless of which
 * provider is actually configured — is never a second storage backend to
 * keep in sync, only a read-side interpretation of one self-contained
 * representation. Never used for NEW uploads — `resolveAssetStorageProvider`
 * remains the only decision about where new bytes go.
 */
const DATA_URI_FALLBACK_PROVIDER = new DataUriAssetStorageProvider();

function isDataUriObjectKey(objectKey: string): boolean {
  return objectKey.startsWith("data:");
}

/**
 * Intermediate-Asset-Persistence-Durability Phase (real Signs acceptance
 * incident: SQLSTATE 57014 and ECONNRESET both observed at this exact
 * boundary across real recovery attempts): bounded, narrow retry ONLY for
 * error classes independently established as capable of occurring AFTER a
 * connection was already carrying real bytes — never assumed to mean
 * "nothing was sent" (that would be exactly the mistake this phase's own
 * audit was told not to make). Mirrors the admission discipline
 * `provider-error.ts`'s `PROVABLY_PRE_DISPATCH_CODES` documents for a
 * different boundary: a code belongs here only because retrying it is
 * safe GIVEN the self-heal existence-check this module always runs first
 * (see `uploadWithExistenceCheckAndBoundedRetry`) — never because the
 * code alone "looks transient".
 */
const RETRYABLE_TRANSPORT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/** Maximum ADDITIONAL attempts after the first — never the total attempt count. */
const MAX_PERSISTENCE_TRANSPORT_RETRY_ATTEMPTS = 2;

function isRetryableTransportError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_TRANSPORT_ERROR_CODES.has(code)) return true;
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === "string" && RETRYABLE_TRANSPORT_ERROR_CODES.has(causeCode)) return true;
    }
  }
  // Node/undici commonly wraps the underlying socket error in a bare
  // "fetch failed" TypeError whose OWN `.code` is absent — the real code
  // lives on `.cause` (already checked above). This catches the rare case
  // where even that's missing but the message still names it.
  if (error instanceof Error && /fetch failed/i.test(error.message)) return true;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read-only, provider-neutral existence check using `AssetStorageProvider`'s
 * ALREADY-EXISTING `download` method — no new interface primitive added.
 * `buildObjectKey`'s own determinism (same `projectId`+`conceptId`+
 * `fileName` always resolves to the same key) is what makes this a
 * meaningful check at all: if a PRIOR attempt's bytes already landed at
 * this exact key, this finds them. Byte-length equality is a real, but
 * deliberately modest, match check ("where available", per this phase's
 * own design brief) — not a cryptographic guarantee, just enough to reject
 * an unrelated stale object at a key that shouldn't normally collide.
 */
async function objectAlreadyLandedAt(
  storage: AssetStorageProvider,
  objectKey: string,
  expectedByteLength: number,
): Promise<boolean> {
  try {
    const bytes = await storage.download(objectKey);
    return bytes.length === expectedByteLength;
  } catch {
    return false;
  }
}

/**
 * Intermediate-Asset-Persistence-Durability Phase: the storage-upload sub-
 * step, hardened with a self-heal-then-bounded-retry design —
 * "CHECK FOR SUCCESS, RETRY ONLY IF SAFE", never a blind repeated write.
 *
 * On ANY upload failure (regardless of classification — never assumed to
 * mean "the server did nothing", per this phase's own explicit audit
 * requirement), first checks whether the deterministic object already
 * landed (`objectAlreadyLandedAt`). If so, the upload already succeeded —
 * adopt it immediately, no retry, no duplicate write. Only when the object
 * genuinely does not exist AND the failure is one independently classified
 * as capable of occurring without the server having accepted anything
 * (`isRetryableTransportError`) does this retry, bounded to
 * `MAX_PERSISTENCE_TRANSPORT_RETRY_ATTEMPTS` additional attempts with a
 * short linear backoff. A non-retryable failure (or a retryable one that's
 * exhausted its budget) propagates immediately.
 */
async function uploadStorageWithSelfHealAndBoundedRetry(
  storage: AssetStorageProvider,
  input: { projectId: string; conceptId: string; fileName: string; bytes: Buffer; contentType: string },
): Promise<{ objectKey: string }> {
  const objectKey = buildObjectKey(input);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await storage.upload(input);
    } catch (error) {
      if (await objectAlreadyLandedAt(storage, objectKey, input.bytes.length)) {
        return { objectKey };
      }
      if (!isRetryableTransportError(error) || attempt >= MAX_PERSISTENCE_TRANSPORT_RETRY_ATTEMPTS) {
        throw error;
      }
      await delay(250 * (attempt + 1));
    }
  }
}

/**
 * Intermediate-Asset-Persistence-Durability Phase: after a `createAsset`
 * failure, checks whether the INSERT actually committed despite the
 * client-side error (a `statement_timeout` can fire on the response path
 * after Postgres already wrote the row; a connection reset can happen
 * after the server's own commit). No automatic in-process retry is
 * attempted for `createAsset` itself (see this phase's own report for why
 * a same-process retry has low expected value against the specific
 * SQLSTATE 57014 failures observed here) — this self-heal check is what
 * makes a LATER, outer retry (the existing, human-gated "resume existing
 * provider result" action, or any other caller of
 * `persistIntermediateReconstruction`) safe: it will find this exact row
 * via `listAssetsForFinalArtworkJob` and adopt it rather than duplicating.
 * Matches on `finalArtworkJobId` + `productionRole` + the exact
 * `storageKey` this attempt just uploaded to — the deterministic key
 * makes this precise, not merely "a" matching row.
 */
async function findAdoptableProductionAsset(
  repo: ProjectRepository,
  projectId: string,
  finalArtworkJobId: string,
  productionRole: ProductionAssetRole,
  storageKey: string,
): Promise<AssetRecord | null> {
  const candidates = await repo.listAssetsForFinalArtworkJob(projectId, finalArtworkJobId);
  return (
    candidates.find(
      (asset) => asset.productionRole === productionRole && asset.storageKey === storageKey,
    ) ?? null
  );
}

/**
 * Production Asset Storage Correction Phase (real Signs acceptance
 * incident: an intermediate asset for the exact same job was ultimately
 * found durably persisted despite the client-visible `createAsset` call
 * having errored with SQLSTATE 57014): which `createAsset` failures are
 * classified "ambiguous" — capable of having actually committed despite the
 * client seeing an error — versus a failure safe to treat as a confirmed
 * non-write. Deliberately narrow: 57014 (`statement_timeout`) is Postgres
 * cancelling a statement already in flight, on the response path, after the
 * write may already have reached disk — never assumed to mean "nothing
 * happened", the same discipline already established for storage transport
 * errors. The same transport-reset codes used for storage retry
 * (`RETRYABLE_TRANSPORT_ERROR_CODES`) are reused here for the identical
 * reason: a connection reset can happen after the server's own commit, not
 * only before it. Every other error (a validation failure, a uniqueness
 * violation, "permission denied") is a confirmed non-write or a confirmed
 * rejection — never given the extra delayed look; blanket-classifying every
 * DB error as ambiguous would only add latency to genuine failures.
 */
const AMBIGUOUS_DB_WRITE_SQLSTATES = new Set(["57014"]);

function isAmbiguousDbWriteError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (AMBIGUOUS_DB_WRITE_SQLSTATES.has(code) || RETRYABLE_TRANSPORT_ERROR_CODES.has(code))
    ) {
      return true;
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const causeCode = (cause as { code?: unknown }).code;
      if (
        typeof causeCode === "string" &&
        (AMBIGUOUS_DB_WRITE_SQLSTATES.has(causeCode) || RETRYABLE_TRANSPORT_ERROR_CODES.has(causeCode))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Bounded, deterministic, single extra wait before the ONE additional
 * lineage lookup for an ambiguous `createAsset` failure — never a loop,
 * never a second INSERT. Long enough to give a genuinely-in-flight commit a
 * real chance to become visible; short enough to bound worst-case added
 * latency to a single constant.
 */
const AMBIGUOUS_CREATE_ASSET_SELF_HEAL_DELAY_MS = 400;

/** Signed URLs default to a short lifetime — "Signed URLs should expire." */
export const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 300;
/** Hard upper bound so callers cannot mint long-lived customer access. */
export const MAX_SIGNED_URL_EXPIRY_SECONDS = 900;

function clampSignedUrlExpirySeconds(expiresInSeconds?: number): number {
  if (
    expiresInSeconds === undefined ||
    !Number.isFinite(expiresInSeconds) ||
    expiresInSeconds <= 0
  ) {
    return DEFAULT_SIGNED_URL_EXPIRY_SECONDS;
  }
  return Math.min(Math.floor(expiresInSeconds), MAX_SIGNED_URL_EXPIRY_SECONDS);
}

export interface UploadConceptAssetInput {
  /**
   * Internal storage-grouping id — see `AssetStorageProvider`'s
   * `UploadAssetInput.conceptId` doc. Not necessarily equal to any
   * database row id.
   */
  conceptId: string;
  bytes: Buffer;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  providerKey: string | null;
  generationJobId: string | null;
  metadata: Record<string, unknown>;
}

export interface UploadConceptAssetResult {
  primary: AssetRecord;
  /** `null` when thumbnail generation wasn't possible — never fatal, see module doc. */
  thumbnail: AssetRecord | null;
}

/** Sprint 2M Phase 2C: input for persisting one production-stage deliverable. */
export interface UploadProductionAssetInput {
  /** Internal storage-grouping id — see `AssetStorageProvider`'s `UploadAssetInput.conceptId` doc. */
  conceptId: string;
  bytes: Buffer;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  finalArtworkJobId: string;
  productionRole: ProductionAssetRole;
  /** Sanitized transformation provenance only — never prompt text or credentials. */
  metadata: Record<string, unknown>;
}

/**
 * Existing Artwork → Print Ready Phase 1: input for persisting artwork the
 * CUSTOMER supplied, or a deterministic derivative of it. Deliberately its
 * own input type rather than a reuse of `UploadConceptAssetInput`, because
 * every provenance field on that one is wrong here: there is no
 * `providerKey`, no `generationJobId`, and no generation of any kind.
 */
export interface UploadCustomerArtworkInput {
  /** Internal storage-grouping id — see `AssetStorageProvider`'s `UploadAssetInput.conceptId` doc. */
  conceptId: string;
  bytes: Buffer;
  contentType: string;
  widthPx: number | null;
  heightPx: number | null;
  hasTransparency: boolean | null;
  /**
   * `"customer_upload"` for the immutable original; `"png"` for a derived,
   * background-prepared asset. Always explicit — never inferred from the
   * content type or from whether other fields happen to be set.
   */
  kind: Extract<AssetKind, "customer_upload" | "png">;
  /** Sanitized, non-secret provenance only. Never a raw filename used as a path. */
  metadata: Record<string, unknown>;
}

export interface AssetCapability {
  listAssets(designId: string): Promise<AssetRecord[]>;
  registerAsset(
    designId: string,
    input: Omit<AssetRecord, "id" | "projectId" | "createdAt">,
  ): Promise<AssetRecord | null>;
  /**
   * Sprint 2H Part 2A: uploads real image bytes through the configured
   * storage backend, attempts a thumbnail, and persists both as linked
   * `AssetRecord`s. If persisting the primary asset's metadata fails after
   * its bytes already landed in storage, the upload is cleaned up and the
   * error re-thrown (Asset Cleanup: "prevent orphaned uploads"). A
   * thumbnail failure (generation or its own upload/persist) is never
   * fatal — `thumbnail` is simply `null`.
   */
  uploadConceptImage(
    designId: string,
    input: UploadConceptAssetInput,
  ): Promise<UploadConceptAssetResult>;
  /**
   * Sprint 2M Phase 2C: uploads a production-stage deliverable
   * (`finalArtworkJobId` + `productionRole` set — never a concept-stage
   * asset). No thumbnail: production assets are never rendered directly to
   * the customer (Goal 14 — a future download boundary would mint its own
   * signed URL). Same orphan-cleanup guarantee as `uploadConceptImage`: a
   * metadata-persist failure after bytes land in storage cleans up the
   * upload and rethrows.
   */
  uploadProductionAsset(
    designId: string,
    input: UploadProductionAssetInput,
  ): Promise<AssetRecord>;
  /**
   * Existing Artwork → Print Ready Phase 1: persists customer-supplied
   * artwork (or a deterministic derivative of it). No thumbnail companion —
   * an uploaded original and its prepared counterpart are both rendered
   * through their own short-lived signed URLs, and a thumbnail would only
   * add a third asset whose provenance is ambiguous.
   *
   * Same orphan-cleanup guarantee as `uploadConceptImage`: if the metadata
   * write fails after bytes land in storage, the upload is cleaned up and
   * the error rethrown.
   */
  uploadCustomerArtwork(
    designId: string,
    input: UploadCustomerArtworkInput,
  ): Promise<AssetRecord>;
  /**
   * A short-lived, expiring URL a browser can fetch directly — never a raw
   * object key. Returns `null` if the asset doesn't exist or has no stored
   * bytes.
   */
  getSignedUrl(
    assetId: string,
    expiresInSeconds?: number,
  ): Promise<string | null>;
  /**
   * Sprint 2M Phase 2C: fetches an asset's raw bytes server-side — distinct
   * from `getSignedUrl` (a browser-facing URL). Needed by
   * `FinalArtworkWorkerCapability` to decode and resample a source
   * concept's real pixels locally, never sent anywhere external. Returns
   * `null` if the asset doesn't exist or has no stored bytes.
   */
  downloadAssetBytes(
    assetId: string,
  ): Promise<{ bytes: Buffer; contentType: string } | null>;
  /** Cleanup only — see `ProjectRepository.deleteAsset`'s doc. */
  deleteAsset(assetId: string): Promise<void>;
}

export function createAssetCapability(
  repo: ProjectRepository,
  storage: AssetStorageProvider,
  thumbnails: ThumbnailGenerator,
): AssetCapability {
  return {
    async listAssets(designId) {
      return repo.listAssets(designId);
    },

    async registerAsset(designId, input) {
      return repo.createAsset(designId, input);
    },

    async uploadConceptImage(designId, input) {
      // Phase 2C.2C: the two stages are tagged, not merely allowed to
      // propagate. A concept image is very often something a paid provider
      // has ALREADY been billed for by the time this runs, and from outside
      // this capability "storage refused the bytes" and "the database
      // refused the row" are indistinguishable — yet they are the two
      // failures an operator most needs told apart when money has moved.
      // The original message and stack are preserved (see
      // `asPaidImagePersistenceError`); only a classification is added.
      let uploadedOriginal: { objectKey: string };
      try {
        uploadedOriginal = await storage.upload({
          projectId: designId,
          conceptId: input.conceptId,
          fileName: `original${extensionForContentType(input.contentType)}`,
          bytes: input.bytes,
          contentType: input.contentType,
        });
      } catch (error) {
        throw asPaidImagePersistenceError(error, "storage_upload_failure");
      }

      let primary: AssetRecord;
      try {
        primary = await repo.createAsset(designId, {
          kind: "generated_artwork",
          storageKey: uploadedOriginal.objectKey,
          contentType: input.contentType,
          isThumbnail: false,
          widthPx: input.widthPx,
          heightPx: input.heightPx,
          hasTransparency: input.hasTransparency,
          providerKey: input.providerKey,
          generationJobId: input.generationJobId,
          metadata: input.metadata,
          vectorAssetId: null,
          printAssetId: null,
          finalArtworkJobId: null,
          productionRole: null,
        });
      } catch (error) {
        // Asset Cleanup: bytes landed in storage but the record that would
        // reference them never did — never leave that orphaned.
        await safeDelete(storage, uploadedOriginal.objectKey);
        throw asPaidImagePersistenceError(error, "asset_persistence_failure");
      }

      const thumbnail = await tryCreateThumbnail(
        repo,
        storage,
        thumbnails,
        designId,
        input,
      );

      return { primary, thumbnail };
    },

    async uploadProductionAsset(designId, input) {
      const uploadInput = {
        projectId: designId,
        conceptId: input.conceptId,
        fileName: `production${extensionForContentType(input.contentType)}`,
        bytes: input.bytes,
        contentType: input.contentType,
      };

      const uploaded = await withOperationTiming("uploadProductionAsset.storageUpload", () =>
        uploadStorageWithSelfHealAndBoundedRetry(storage, uploadInput),
      );

      // Manual timing (not `withOperationTiming`) so the RAW caught error
      // — with its own `.code`/`.cause.code` intact — is available to
      // `isAmbiguousDbWriteError` below. `withOperationTiming` would already
      // have replaced it with a new plain `Error` carrying only a formatted
      // message by the time a catch block here could inspect it, exactly
      // like `runSignReconstructionAndContinue`'s own produce-vs-resume
      // dispatch already avoids that helper for the same reason. The final
      // thrown error still carries the identical
      // `"<label> failed after <n>ms: <safe description>"` shape either way.
      const createAssetStartedAt = Date.now();
      try {
        const created = await repo.createAsset(designId, {
          kind: "generated_artwork",
          storageKey: uploaded.objectKey,
          contentType: input.contentType,
          isThumbnail: false,
          widthPx: input.widthPx,
          heightPx: input.heightPx,
          hasTransparency: input.hasTransparency,
          providerKey: null,
          generationJobId: null,
          metadata: input.metadata,
          vectorAssetId: null,
          printAssetId: null,
          finalArtworkJobId: input.finalArtworkJobId,
          productionRole: input.productionRole,
        });
        console.info(
          `[assets] operation=uploadProductionAsset.createAsset elapsed_ms=${Date.now() - createAssetStartedAt} outcome=success`,
        );
        return created;
      } catch (rawError) {
        const elapsedMs = Date.now() - createAssetStartedAt;
        console.info(
          `[assets] operation=uploadProductionAsset.createAsset elapsed_ms=${elapsedMs} outcome=error`,
        );
        const labeledError = new Error(
          boundedErrorDescription(
            `uploadProductionAsset.createAsset failed after ${elapsedMs}ms: ${describeOperationError(rawError)}`,
          ),
        );

        const immediatelyAdopted = await withOperationTiming(
          "uploadProductionAsset.createAsset.immediateLineageLookup",
          () =>
            findAdoptableProductionAsset(
              repo,
              designId,
              input.finalArtworkJobId,
              input.productionRole,
              uploaded.objectKey,
            ),
        );
        if (immediatelyAdopted) return immediatelyAdopted;

        // Production Asset Storage Correction Phase: an ambiguous DB-write
        // failure (SQLSTATE 57014, or a transport reset that could equally
        // have happened after the server's own commit) gets ONE bounded,
        // deterministic extra chance to become visible before cleanup runs
        // — never a second INSERT, never a loop. A non-ambiguous failure
        // (a validation error, a uniqueness violation) skips straight to
        // cleanup: the immediate lookup already found nothing, and there is
        // no reason to believe waiting would change that.
        if (isAmbiguousDbWriteError(rawError)) {
          await delay(AMBIGUOUS_CREATE_ASSET_SELF_HEAL_DELAY_MS);
          const delayedAdopted = await withOperationTiming(
            "uploadProductionAsset.createAsset.delayedLineageLookup",
            () =>
              findAdoptableProductionAsset(
                repo,
                designId,
                input.finalArtworkJobId,
                input.productionRole,
                uploaded.objectKey,
              ),
          );
          if (delayedAdopted) return delayedAdopted;
        }

        // Same orphan-cleanup guarantee as uploadConceptImage — only
        // reached once both lookups (immediate, and — for an ambiguous
        // failure — the bounded delayed retry) confirmed no row adopted
        // this object, so cleanup can never delete something a successful
        // continuation is now relying on. Still bounded: this is not
        // unbounded orphan preservation, only a single deterministic wait.
        await withOperationTiming("uploadProductionAsset.cleanupStorage", () =>
          safeDelete(storage, uploaded.objectKey),
        );
        throw labeledError;
      }
    },

    async uploadCustomerArtwork(designId, input) {
      const uploaded = await storage.upload({
        projectId: designId,
        conceptId: input.conceptId,
        fileName: `${
          input.kind === "customer_upload" ? "source" : "prepared"
        }${extensionForContentType(input.contentType)}`,
        bytes: input.bytes,
        contentType: input.contentType,
      });

      try {
        return await repo.createAsset(designId, {
          kind: input.kind,
          storageKey: uploaded.objectKey,
          contentType: input.contentType,
          isThumbnail: false,
          widthPx: input.widthPx,
          heightPx: input.heightPx,
          hasTransparency: input.hasTransparency,
          // Nothing generated these pixels — the customer supplied them.
          providerKey: null,
          generationJobId: null,
          metadata: input.metadata,
          vectorAssetId: null,
          printAssetId: null,
          finalArtworkJobId: null,
          productionRole: null,
        });
      } catch (error) {
        await safeDelete(storage, uploaded.objectKey);
        throw error;
      }
    },

    async getSignedUrl(assetId, expiresInSeconds) {
      const asset = await repo.getAssetById(assetId);
      if (!asset || !asset.storageKey) return null;
      const expirySeconds = clampSignedUrlExpirySeconds(expiresInSeconds);
      // Historical-representation-aware read: a data URI is self-contained
      // and never needs the configured provider — see
      // `DATA_URI_FALLBACK_PROVIDER`'s own doc.
      // `DataUriAssetStorageProvider.getSignedUrl` ignores expiry (a data
      // URI is already a self-contained, non-expiring representation).
      return isDataUriObjectKey(asset.storageKey)
        ? DATA_URI_FALLBACK_PROVIDER.getSignedUrl(asset.storageKey)
        : storage.getSignedUrl(asset.storageKey, expirySeconds);
    },

    async downloadAssetBytes(assetId) {
      const asset = await repo.getAssetById(assetId);
      if (!asset || !asset.storageKey) return null;
      const bytes = isDataUriObjectKey(asset.storageKey)
        ? await DATA_URI_FALLBACK_PROVIDER.download(asset.storageKey)
        : await storage.download(asset.storageKey);
      return { bytes, contentType: asset.contentType ?? "application/octet-stream" };
    },

    async deleteAsset(assetId) {
      const asset = await repo.getAssetById(assetId);
      if (!asset) return;
      if (asset.storageKey) {
        // A data URI has nothing external to remove (`DataUriAssetStorageProvider.delete`
        // is already a no-op) — routing it there rather than the configured
        // provider only matters if that provider would otherwise misinterpret
        // the data URI string as one of its own object keys.
        await (isDataUriObjectKey(asset.storageKey)
          ? safeDelete(DATA_URI_FALLBACK_PROVIDER, asset.storageKey)
          : safeDelete(storage, asset.storageKey));
      }
      await repo.deleteAsset(assetId);
    },
  };
}

/**
 * Thumbnail generation and its own upload/persist are never allowed to
 * fail the whole concept — "Thumbnail failure" is explicitly a recoverable
 * failure mode (Sprint 2H Part 2A). Any error along this path is logged
 * internally (never surfaced to the customer) and swallowed; the caller
 * just gets `null` back.
 */
async function tryCreateThumbnail(
  repo: ProjectRepository,
  storage: AssetStorageProvider,
  thumbnails: ThumbnailGenerator,
  designId: string,
  input: UploadConceptAssetInput,
): Promise<AssetRecord | null> {
  try {
    const generated = await thumbnails.generate({
      bytes: input.bytes,
      contentType: input.contentType,
    });
    if (!generated) return null;

    const uploadedThumb = await storage.upload({
      projectId: designId,
      conceptId: input.conceptId,
      fileName: `thumb${extensionForContentType(generated.contentType)}`,
      bytes: generated.bytes,
      contentType: generated.contentType,
    });

    try {
      return await repo.createAsset(designId, {
        kind: "generated_artwork",
        storageKey: uploadedThumb.objectKey,
        contentType: generated.contentType,
        isThumbnail: true,
        widthPx: generated.widthPx,
        heightPx: generated.heightPx,
        hasTransparency: input.hasTransparency,
        providerKey: input.providerKey,
        generationJobId: input.generationJobId,
        metadata: {},
        vectorAssetId: null,
        printAssetId: null,
        finalArtworkJobId: null,
        productionRole: null,
      });
    } catch (error) {
      await safeDelete(storage, uploadedThumb.objectKey);
      logThumbnailFailure(error);
      return null;
    }
  } catch (error) {
    logThumbnailFailure(error);
    return null;
  }
}

function logThumbnailFailure(error: unknown): void {
  console.error("[assets] thumbnail generation failed (non-fatal)", {
    message: error instanceof Error ? error.message : String(error),
  });
}

async function safeDelete(
  storage: AssetStorageProvider,
  objectKey: string,
): Promise<void> {
  try {
    await storage.delete(objectKey);
  } catch (error) {
    // Asset Cleanup: "If cleanup fails: Log internally. Do not expose to
    // customers." — never let a cleanup failure surface further.
    console.error("[assets] failed to clean up an orphaned upload", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function extensionForContentType(contentType: string): string {
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/jpeg") return ".jpg";
  return "";
}

export type { AssetKind, AssetRecord };
