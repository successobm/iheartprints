import { createHash } from "node:crypto";

import { PNG } from "pngjs";

import { isAuthorizedForArtworkCorrection } from "@/capabilities/artwork-preparation/artwork-correction-authorization";
import { getCapabilityGraph } from "@/capabilities/composition";
import { getProjectRepository } from "@/lib/db";
import { decodePngUpload } from "@/capabilities/artwork-preparation/image-decode";
import { analyzeArtwork } from "@/capabilities/artwork-preparation/image-analysis";
import {
  computeRegionMap,
  buildSeparationMaster,
  renderRegionContextHighlight,
  renderRegionDetailCrop,
  renderProposalHighlight,
  replayPreserveOperations,
  type ProposalAuthority,
} from "@/capabilities/artwork-preparation/region-separation";
import { compositeOverGarment } from "@/capabilities/final-artwork/halftone-screen";
import { resolveGarmentColor } from "@/capabilities/shared/production-treatment";
import type { RgbaImage } from "@/capabilities/final-artwork/raster-transform";
import type { SeparationDecisionSet } from "@/capabilities/artwork-preparation/region-separation-contracts";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Intelligent Separation Phase 9 / Phase 28K: renders the images this
 * project's own review UI needs, server-side, from the SAME deterministic
 * functions the capability uses — never a second implementation of the
 * highlight/composite logic. `SeparationReviewPanel` (mounted directly in
 * the ordinary customer flow since Phase 28F) fetches every mode below,
 * including `region-context`/`region-crop` — none of this is staff-only in
 * practice, so none of it should be staff-only in authorization either.
 *
 * ENFORCED SERVER-SIDE — Phase 28K's "internal staff OR this project's own
 * owner" gate; see `isAuthorizedForArtworkCorrection`'s doc comment. Same
 * deliberately uninformative 404 either way.
 *
 * `mode`:
 *   original         the immutable original, unmodified
 *   region-overlay    the original with ONE region tinted magenta (requires `region`)
 *   region-context     Phase 14: the full canvas with every pixel OUTSIDE the
 *                       requested region dimmed toward neutral gray and the
 *                       region itself highlighted with a two-tone outline —
 *                       so the operator sees exactly which area a question
 *                       is about, not a same-looking full-canvas thumbnail
 *                       (requires `region`)
 *   region-crop        Phase 14: the same highlight, cropped to a padded,
 *                       size-floored, edge-clamped box around the region's
 *                       own deterministic bounds — the "detail view"
 *                       (requires `region`)
 *   master             the deterministic master built from PERSISTED decisions
 *                      (or, if none exist yet, none-dropped — i.e. every
 *                      consequential region shown as ink, so a first-visit
 *                      preview is never blocked on a decision existing)
 *   master-preview     the master composited over a requested garment colour
 *                      (`garment`, a `#RRGGBB` hex) — PREVIEW ONLY, never
 *                      persisted, never the deliverable (Goal 6).
 *
 * Never persisted, never cached anywhere shared — an operator is looking at
 * their own in-progress, mutable review state.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const graph = getCapabilityGraph();

    if (!(await isAuthorizedForArtworkCorrection(graph.acquisition, getProjectRepository(), projectId))) {
      return new Response("Not found", { status: 404 });
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "master";
    if (
      !["original", "region-overlay", "region-context", "region-crop", "master", "master-preview", "proposal-highlight"].includes(
        mode,
      )
    ) {
      return new Response("Not found", { status: 404 });
    }

    const repo = getProjectRepository();
    const preparation = await repo.getArtworkPreparation(projectId);
    if (!preparation || preparation.projectId !== projectId) {
      return new Response("Not found", { status: 404 });
    }
    const downloaded = await graph.assets.downloadAssetBytes(preparation.originalAssetId);
    if (!downloaded) return new Response("Not found", { status: 404 });

    const decoded = decodePngUpload(downloaded.bytes);
    const original = decoded.image;

    if (mode === "original") return pngResponse(encodePng(original));

    const analysis = analyzeArtwork({
      image: original,
      format: "image/png",
      byteSize: downloaded.bytes.length,
      declaresAlphaChannel: decoded.header.declaresAlphaChannel,
      printPlacement: null,
      intendedPrintWidthIn: null,
    });
    const sourceAssetSha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
    const computation = computeRegionMap(
      original,
      sourceAssetSha256,
      analysis.estimatedBackgroundColor,
      analysis.backgroundTolerance,
    );

    if (mode === "region-overlay" || mode === "region-context" || mode === "region-crop") {
      const regionId = Number(url.searchParams.get("region"));
      if (!Number.isFinite(regionId)) {
        return NextResponseNotFound();
      }
      const region = computation.regionMap.consequentialRegions.find((r) => r.regionId === regionId);
      if (!region) return NextResponseNotFound();

      if (mode === "region-overlay") {
        return pngResponse(encodePng(overlayRegion(original, computation.label, regionId)));
      }
      if (mode === "region-context") {
        return pngResponse(encodePng(renderRegionContextHighlight(original, computation.label, regionId)));
      }
      return pngResponse(
        encodePng(renderRegionDetailCrop(original, computation.label, regionId, region.bounds)),
      );
    }

    const decisionSet = preparation.separation
      ? (preparation.separation as unknown as SeparationDecisionSet)
      : null;
    const decisions = decisionSet?.decisions ?? [];

    // Phase 23: the SAME proposal-authority derivation the capability layer
    // uses (never a second implementation) — a stale or absent decision set
    // always resolves toward "pending" (retain everything), so this preview
    // can never show a pixel as removed that the capability would not also
    // remove.
    const proposalHash = computation.regionMap.inBoundsProposal?.proposalHash ?? null;
    const proposalDecision: SeparationDecisionSet["proposalDecision"] =
      !computation.regionMap.inBoundsProposal || !decisionSet || decisionSet.proposalHash !== proposalHash
        ? "pending"
        : decisionSet.proposalDecision;
    const proposalPreserveOps =
      decisionSet && decisionSet.proposalHash === proposalHash ? decisionSet.proposalPreserveOps : [];
    const proposalAuthority: ProposalAuthority = { decision: proposalDecision, preserveOperations: proposalPreserveOps };

    if (mode === "proposal-highlight") {
      if (!computation.proposalMask) return NextResponseNotFound();
      const preservedMask =
        proposalDecision === "preserve_all"
          ? computation.proposalMask
          : replayPreserveOperations(computation.proposalMask, original.width, original.height, proposalPreserveOps);
      return pngResponse(encodePng(renderProposalHighlight(original, computation.proposalMask, preservedMask)));
    }

    const master = buildSeparationMaster(original, computation, decisions, proposalAuthority);

    if (mode === "master") return pngResponse(encodePng(master));

    // master-preview
    const garmentParam = url.searchParams.get("garment") ?? "#000000";
    const garment = resolveGarmentColor(garmentParam) ?? {
      label: "Preview",
      hex: "#000000",
      rgb: { r: 0, g: 0, b: 0 },
    };
    return pngResponse(encodePng(compositeOverGarment(master, garment)));
  } catch (error) {
    console.error("Failed to render separation review image", error);
    return new Response("Not found", { status: 404 });
  }
}

function overlayRegion(original: RgbaImage, label: Int32Array, regionId: number): RgbaImage {
  const data = Buffer.from(original.data);
  for (let i = 0; i < label.length; i += 1) {
    if (label[i] !== regionId) continue;
    data[i * 4] = 255;
    data[i * 4 + 1] = 0;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  return { width: original.width, height: original.height, data };
}

function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  image.data.copy(png.data);
  return PNG.sync.write(png);
}

function pngResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, no-store",
    },
  });
}

function NextResponseNotFound(): Response {
  return new Response("Not found", { status: 404 });
}
