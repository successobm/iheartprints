import { NextResponse } from "next/server";

import { getFinalizationStatus } from "@/lib/services/conversation-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Lightweight, provider-neutral finalization polling endpoint — the
 * finalization counterpart of `GET .../generation/status`. Cheap enough
 * for the conversation to check every few seconds while a FinalArtworkJob
 * runs in the background. Returns only `{ status }` from the customer-safe
 * `CustomerFinalizationStatus` vocabulary: never a job id, provider name,
 * queue name, storage key, or any other internal detail.
 *
 * Purely read-only. Polling never recovers abandoned jobs, never claims
 * work, never revives a failed job, and never calls a provider.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const status = await getFinalizationStatus(projectId);

    if (!status) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json(status);
  } catch (error) {
    console.error("Failed to check finalization status", error);
    return NextResponse.json(
      { error: "Failed to check finalization status" },
      { status: 500 },
    );
  }
}
