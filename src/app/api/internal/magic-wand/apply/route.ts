/**
 * Phase 27C/27D — EXPERIMENTAL / LOCAL-ONLY. Accepts (persists in-memory)
 * a magic-wand operation — a raw LIST of clicks (Phase 27D additive
 * selection) + mode + tolerance level only, never a mask — then returns
 * the operation id. One accepted operation always corresponds to exactly
 * one Undo step, regardless of how many clicks it was built from (see
 * Phase 27D report §F). Mirrors this codebase's raw-intent replay
 * discipline. The client re-fetches GET .../result to see the new
 * authoritative image; this route never embeds pixel bytes.
 */
import { NextResponse } from "next/server";
import { acceptOperation } from "@/experimental/magic-wand/lab-state";
import { isToleranceLevel, type CorrectionAction, type Point } from "@/experimental/magic-wand/magic-wand";

function isPoint(value: unknown): value is Point {
  return !!value && typeof value === "object" && typeof (value as Point).x === "number" && typeof (value as Point).y === "number";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { clicks?: unknown; mode?: unknown; toleranceLevel?: unknown }
    | null;
  if (
    !body ||
    !Array.isArray(body.clicks) ||
    body.clicks.length === 0 ||
    !body.clicks.every(isPoint) ||
    (body.mode !== "restore" && body.mode !== "remove") ||
    !isToleranceLevel(body.toleranceLevel)
  ) {
    return NextResponse.json(
      { error: "clicks (non-empty array of {x,y}), mode (restore|remove), toleranceLevel (less|default|more) are required" },
      { status: 400 },
    );
  }
  const mode = body.mode as CorrectionAction;
  const clicks = body.clicks as Point[];
  const op = acceptOperation(clicks, mode, body.toleranceLevel);
  return NextResponse.json({ operationId: op.operationId, algorithmVersion: op.algorithmVersion });
}
