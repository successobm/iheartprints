import { NextResponse } from "next/server";

import type { SignEdge } from "@/capabilities/sign-preparation";
import { getProjectRepository } from "@/lib/db";
import { readAcquisitionSessionTokenFromRequest } from "@/lib/http/acquisition-session-cookie";
import { previewSignCorrections, type PendingSignCorrection } from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

const SIGN_EDGES: readonly SignEdge[] = ["top", "right", "bottom", "left"];
function isSignEdge(value: unknown): value is SignEdge {
  return typeof value === "string" && (SIGN_EDGES as readonly string[]).includes(value);
}

function parseCorrections(body: unknown): PendingSignCorrection[] | null {
  if (!Array.isArray(body)) return null;
  const corrections: PendingSignCorrection[] = [];
  for (const raw of body as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.kind === "remove") {
      const { xPx, yPx, widthPx, heightPx, contextDepthPx } = raw;
      if (
        typeof xPx !== "number" || typeof yPx !== "number" ||
        typeof widthPx !== "number" || typeof heightPx !== "number" ||
        typeof contextDepthPx !== "number"
      ) {
        return null;
      }
      corrections.push({ kind: "remove", xPx, yPx, widthPx, heightPx, contextDepthPx });
    } else if (raw.kind === "move") {
      const { sourceStartYPx, heightPx, destStartYPx } = raw;
      if (typeof sourceStartYPx !== "number" || typeof heightPx !== "number" || typeof destStartYPx !== "number") {
        return null;
      }
      corrections.push({ kind: "move", sourceStartYPx, heightPx, destStartYPx });
    } else if (raw.kind === "classify") {
      const { classificationKind, edges, xPx, yPx, widthPx, heightPx } = raw;
      if (
        (classificationKind !== "edge_intent" && classificationKind !== "protected") ||
        !Array.isArray(edges) || edges.length === 0 || !edges.every(isSignEdge) ||
        typeof xPx !== "number" || typeof yPx !== "number" ||
        typeof widthPx !== "number" || typeof heightPx !== "number"
      ) {
        return null;
      }
      corrections.push({ kind: "classify", classificationKind, edges: edges as SignEdge[], xPx, yPx, widthPx, heightPx });
    } else if (raw.kind === "wand_delete") {
      const { xPx, yPx, widthPx, heightPx, maskBase64, contextDepthPx } = raw;
      if (
        typeof xPx !== "number" || typeof yPx !== "number" ||
        typeof widthPx !== "number" || typeof heightPx !== "number" ||
        typeof maskBase64 !== "string" || maskBase64.length === 0 ||
        typeof contextDepthPx !== "number"
      ) {
        return null;
      }
      corrections.push({ kind: "wand_delete", xPx, yPx, widthPx, heightPx, maskBase64, contextDepthPx });
    } else {
      return null;
    }
  }
  return corrections;
}

/**
 * Operator Production Correction UX: fast, in-memory, NEVER-persisted
 * preview of one or more operator-selected corrections (Smart Remove /
 * Move / Classify) applied on top of the current blocked production
 * candidate — `previewSignCorrections`'s own doc has the full contract.
 * Zero writes, zero Topaz calls. Same session gate as every other internal
 * sign-artwork route: the REQUESTER'S OWN session must be verified
 * internal right now.
 *
 * `POST` body: a JSON array of
 * `{kind:"remove",xPx,yPx,widthPx,heightPx,contextDepthPx}`,
 * `{kind:"move",sourceStartYPx,heightPx,destStartYPx}`, or
 * `{kind:"classify",classificationKind:"edge_intent"|"protected",edges,xPx,yPx,widthPx,heightPx}`
 * entries, in the production candidate's own pixel coordinate space.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const repo = getProjectRepository();

    const token = readAcquisitionSessionTokenFromRequest(request);
    const session = token
      ? await repo.getAcquisitionSessionByToken(token).catch(() => null)
      : null;
    if (!session || session.entitlement !== "internal") {
      return NextResponse.json(
        { error: "This action requires an internal production session." },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => null);
    const corrections = parseCorrections(body);
    if (!corrections || corrections.length === 0) {
      return NextResponse.json(
        { error: "Expected a JSON array of at least one remove/move correction." },
        { status: 400 },
      );
    }

    const result = await previewSignCorrections(projectId, corrections);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to preview the correction";
    console.error("Failed to preview sign correction", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
