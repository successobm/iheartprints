/**
 * LIVE PRODUCT BLOCKER #1: the customer-facing bridge from the Existing
 * Artwork upload into the Signs production authority.
 *
 * The customer uploads ONE file through the ordinary Existing Artwork
 * upload step, before knowing (or being asked) whether it is DTF/apparel
 * or a sign — see `uploaded-artwork-flow.ts`'s `choose_artwork_type` step.
 * When they identify it as a Sign, this is the ONE place that turns those
 * SAME already-uploaded bytes into the Signs profile's own immutable
 * original (`SignPreparationCapability.uploadSignArtwork` — never a second
 * customer upload, never two sources of truth for "what did the customer
 * upload") and then records the human-confirmed ordered size on it
 * (`confirmSignProductionSpec`, Constitution §16A.2 — both dimensions,
 * explicit, never defaulted or inferred).
 *
 * Deliberately its own service file rather than folded into
 * `artwork-preparation-service.ts`: this composes TWO capabilities
 * (`ArtworkPreparationCapability` for the already-uploaded source,
 * `SignPreparationCapability` for the sign authority itself), and neither
 * capability may depend on the other (`ARCHITECTURE.md`'s
 * `SignPreparationCapability` dependency list is `ProjectRepository` +
 * `AssetCapability` only). That composition belongs at the app layer, same
 * as every other cross-capability orchestration in this file's siblings.
 */

import { getCapabilityGraph } from "@/capabilities/composition";
import { describeSignPlanForCustomer } from "@/capabilities/sign-preparation";
import {
  getConversation,
  type ApiProjectSnapshot,
} from "@/lib/services/conversation-service";

export class SignArtworkBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignArtworkBridgeError";
  }
}

/**
 * Idempotent: a second call for a project that already has a
 * `SignPreparation` re-confirms the (possibly changed) size against the
 * SAME sign original rather than adopting the upload a second time —
 * `SignPreparationCapability.uploadSignArtwork` refuses a second upload for
 * one project by construction, so this only ever bridges once.
 */
export async function confirmSignArtworkSize(
  projectId: string,
  input: { orderedWidthIn: number; orderedHeightIn: number },
): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();

  let signPreparation = await graph.signPreparation.getSignPreparation(projectId);
  if (!signPreparation) {
    const reference =
      await graph.artworkPreparation.getOriginalAssetReference(projectId);
    if (!reference) {
      throw new SignArtworkBridgeError(
        "Upload your artwork before choosing a sign size.",
      );
    }
    const downloaded = await graph.assets.downloadAssetBytes(reference.assetId);
    if (!downloaded) {
      throw new SignArtworkBridgeError(
        "We couldn't read your uploaded artwork. Please try uploading again.",
      );
    }
    signPreparation = await graph.signPreparation.uploadSignArtwork(projectId, {
      bytes: downloaded.bytes,
      declaredContentType: downloaded.contentType,
      filename: reference.filename,
    });
  }

  await graph.signPreparation.confirmSignProductionSpec(
    projectId,
    input.orderedWidthIn,
    input.orderedHeightIn,
  );

  const snapshot = await getConversation(projectId);
  if (!snapshot) {
    throw new SignArtworkBridgeError("Project not found");
  }
  return snapshot;
}

/**
 * LIVE PRODUCT BLOCKER #3: "Check my artwork" — the customer's explicit
 * request to run the EXISTING, already-built inspection/diagnosis/planning
 * capability (`SignPreparationCapability.planSignRepair`) and see what it
 * found. This function does no diagnosis of its own: it calls the
 * authoritative capability, then translates its ACTUAL result through
 * `describeSignPlanForCustomer` — the same translation `conversation-
 * service.ts` reconstructs from the durable row on every later reload, so
 * there is exactly one customer-copy authority, not two.
 *
 * Idempotent by the capability's own construction: `planSignRepair`
 * recomputes from the immutable original and the confirmed spec every
 * time and overwrites the SAME `SignPreparation` row — repeated clicks
 * never create a second plan or a competing authority.
 */
export async function planSignArtwork(projectId: string): Promise<ApiProjectSnapshot> {
  const graph = getCapabilityGraph();
  const outcome = await graph.signPreparation.planSignRepair(projectId);

  const snapshot = await getConversation(projectId);
  if (!snapshot || !snapshot.signArtwork) {
    throw new SignArtworkBridgeError("Project not found");
  }

  // The re-read snapshot's `signArtwork.plan` reconstructs correctly from
  // the durable row for a PLANNED outcome (safe or needs-review) — but a
  // BLOCKED outcome durably looks identical to "never planned" (see
  // `SignArtworkView.plan`'s doc), so the customer would see nothing for
  // the very click that just told them it's blocked. Overriding with the
  // view built from THIS call's own fresh, authoritative result closes
  // that gap for the immediate response; reload afterward is documented,
  // deliberate, and safe (re-clicking reproduces the identical result).
  return {
    ...snapshot,
    signArtwork: {
      ...snapshot.signArtwork,
      plan: describeSignPlanForCustomer({
        orderedWidthIn: outcome.preparation.orderedWidthIn ?? 0,
        orderedHeightIn: outcome.preparation.orderedHeightIn ?? 0,
        artworkWidthPx: outcome.inspection.source.widthPx,
        artworkHeightPx: outcome.inspection.source.heightPx,
        defectCodes: outcome.result.defects.map((defect) => defect.code),
        plan: outcome.result.status === "planned" ? outcome.result.plan : null,
      }),
    },
  };
}
