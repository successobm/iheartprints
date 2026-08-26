/**
 * Phase 27C — EXPERIMENTAL / LOCAL-ONLY. Clears every accepted operation,
 * returning to the damaged baseline — a convenience for repeated testing.
 */
import { NextResponse } from "next/server";
import { resetOperations } from "@/experimental/magic-wand/lab-state";

export async function POST() {
  resetOperations();
  return NextResponse.json({ ok: true });
}
