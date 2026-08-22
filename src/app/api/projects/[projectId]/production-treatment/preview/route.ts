import { PNG } from "pngjs";

import { getCapabilityGraph } from "@/capabilities/composition";
import {
  applyHalftoneScreen,
  compositeOverGarment,
} from "@/capabilities/final-artwork/halftone-screen";
import { normalizeProductionRaster } from "@/capabilities/final-artwork/production-normalization";
import {
  resolveProductionSizeConfirmation,
  sizingPolicyForConfirmedSize,
} from "@/capabilities/shared/confirmed-production-size";
import { resolveProductionTreatment } from "@/capabilities/shared/production-treatment";
import { getProjectRepository } from "@/lib/db";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Print'em All Phase 2 (Goal 13): the internal operator's visual comparison
 * surface.
 *
 * THREE MODES, one source of truth:
 *
 *   prepared — the approved, background-prepared transparent artwork, exactly
 *              as it is on file. Never re-processed.
 *   halftone — the screened plate, generated at the CONFIRMED FINAL
 *              PRODUCTION SIZE with the project's PERSISTED settings.
 *   garment  — the same screened plate composited over the resolved garment
 *              colour, so an operator can judge it the way a wearer sees it.
 *
 * WHY IT GENERATES AT FULL PRODUCTION SIZE. A preview rendered at some
 * convenient smaller size would show a different dot-to-artwork ratio than
 * the plate, which is the one thing an operator is looking at this to judge.
 * The browser scales the response down for display; the pixels being scaled
 * are the real ones. This costs a couple of seconds and several megabytes,
 * which is the correct trade for an internal tool and would not be for a
 * customer surface.
 *
 * WHY THERE ARE NO SETTINGS QUERY PARAMETERS. The preview renders the
 * project's DURABLE treatment authority and nothing else, so "what I am
 * looking at" and "what will be produced" are the same statement. An operator
 * changes a control by changing the persisted treatment — which is cheap,
 * retractable, and (Goal 16) the only place production authority may live.
 * Accepting ad-hoc settings here would create a second, transient one.
 *
 * PREVIEW ONLY. The garment composite exists in this response and nowhere
 * else: it is never persisted, never an asset, and never the deliverable.
 * Nothing on this path writes anything.
 *
 * INTERNAL ONLY, checked server-side against the project's own acquisition
 * session — the same gate the write boundary uses, and the same deliberately
 * uninformative 404 for everyone else.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const graph = getCapabilityGraph();

    if (!(await graph.acquisition.isInternalProject(projectId))) {
      return new Response("Not found", { status: 404 });
    }

    const mode = new URL(request.url).searchParams.get("mode") ?? "halftone";
    if (mode !== "prepared" && mode !== "halftone" && mode !== "garment") {
      return new Response("Not found", { status: 404 });
    }

    const repo = getProjectRepository();
    const snapshot = await repo.getProject(projectId);
    if (!snapshot) return new Response("Not found", { status: 404 });

    // Goal 15 / Goal 26: the APPROVED PREPARED asset is the only source this
    // route will read. Never the immutable original, and never a re-run of
    // background removal.
    const preparation = await repo.getArtworkPreparation(projectId);
    if (
      !preparation ||
      preparation.projectId !== projectId ||
      preparation.status !== "approved" ||
      !preparation.preparedAssetId
    ) {
      return new Response("Not found", { status: 404 });
    }

    const sourceAsset = await repo.getAssetById(preparation.preparedAssetId);
    if (!sourceAsset || sourceAsset.projectId !== projectId) {
      return new Response("Not found", { status: 404 });
    }
    const downloaded = await graph.assets.downloadAssetBytes(sourceAsset.id);
    if (!downloaded) return new Response("Not found", { status: 404 });

    if (mode === "prepared") {
      return pngResponse(downloaded.bytes);
    }

    const treatment = resolveProductionTreatment(snapshot.brief);
    if (treatment.treatment !== "halftone_dtf") {
      return new Response("Not found", { status: 404 });
    }

    const confirmation = resolveProductionSizeConfirmation(snapshot.brief);
    if (!confirmation.confirmed || !snapshot.brief.printPlacement) {
      return new Response("Not found", { status: 404 });
    }

    const source = PNG.sync.read(downloaded.bytes);
    // EXACTLY the production order (see `HalftoneDtfProvider`): normalize to
    // the confirmed final production dimensions first, screen second. A
    // preview that screened before resizing would be showing a line frequency
    // the plate will not have.
    const normalized = normalizeProductionRaster(
      { width: source.width, height: source.height, data: source.data },
      sizingPolicyForConfirmedSize(snapshot.brief.printPlacement, confirmation.size),
    );
    if (normalized.status !== "normalized") {
      return new Response("Not found", { status: 404 });
    }

    const screened = applyHalftoneScreen(
      normalized.result.image,
      treatment.halftone,
      normalized.result.metadata.targetPpi,
    );

    const image =
      mode === "garment"
        ? compositeOverGarment(screened.image, treatment.halftone.garment)
        : screened.image;

    const png = new PNG({ width: image.width, height: image.height });
    image.data.copy(png.data);
    return pngResponse(PNG.sync.write(png));
  } catch (error) {
    console.error("Failed to render production treatment preview", error);
    return new Response("Not found", { status: 404 });
  }
}

function pngResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      // Never cached anywhere shared. A preview is derived from an operator's
      // current, mutable treatment settings, and a stale one would be an
      // operator judging a plate they are no longer making.
      "Cache-Control": "private, no-store",
    },
  });
}
