/**
 * Phase 27C — EXPERIMENTAL / LOCAL-ONLY. Serves the immutable original
 * asset, read-only, for the magic-wand correction lab page. Never wired
 * into any production route.
 */
import { getLabState, encodePngResponse } from "@/experimental/magic-wand/lab-state";

export async function GET() {
  const { original } = getLabState();
  return new Response(new Uint8Array(encodePngResponse(original)), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
