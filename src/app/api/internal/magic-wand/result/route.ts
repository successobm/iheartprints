/**
 * Phase 27C — EXPERIMENTAL / LOCAL-ONLY. Returns the current authoritative
 * result: the damaged baseline with every ACCEPTED correction replayed in
 * order, recomputed fresh from raw click/mode/tolerance every time (never
 * a cached mask).
 */
import { computeCurrentResult, encodePngResponse } from "@/experimental/magic-wand/lab-state";

export async function GET() {
  const current = computeCurrentResult();
  return new Response(new Uint8Array(encodePngResponse(current)), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
