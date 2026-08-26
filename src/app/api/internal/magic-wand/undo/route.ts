/**
 * Phase 27C — EXPERIMENTAL / LOCAL-ONLY. Removes the most recently
 * accepted magic-wand operation.
 */
import { NextResponse } from "next/server";
import { undoLastOperation } from "@/experimental/magic-wand/lab-state";

export async function POST() {
  undoLastOperation();
  return NextResponse.json({ ok: true });
}
