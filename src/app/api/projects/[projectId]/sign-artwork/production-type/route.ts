import { NextResponse } from "next/server";
import { z } from "zod";

import { SIGN_PRODUCTION_TYPES } from "@/lib/domain/types";
import { SignPreparationStateError } from "@/capabilities/sign-preparation";
import { getPersistenceMode } from "@/lib/db";
import {
  setSignArtworkProductionType,
  SignArtworkBridgeError,
} from "@/lib/services/sign-artwork-service";

type RouteContext = {
  params: Promise<{ projectId: string }>;
};

/**
 * Banner Production Profile (Constitution amendment 3.3, §16A-bis): the
 * customer's explicit "what are we making?" answer — Rigid Sign or
 * Banner — asked BEFORE dimensions. See `sign-artwork-service.ts`'s
 * `setSignArtworkProductionType` for what this bridges into. Mirrors
 * `sign-artwork/route.ts`'s own size-confirmation route exactly.
 */
const bodySchema = z.object({
  productionType: z.enum(SIGN_PRODUCTION_TYPES),
});

export async function POST(request: Request, context: RouteContext) {
  try {
    const { projectId } = await context.params;
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const snapshot = await setSignArtworkProductionType(projectId, parsed.data.productionType);

    return NextResponse.json({
      ...snapshot,
      persistenceMode: getPersistenceMode(),
    });
  } catch (error) {
    if (error instanceof SignArtworkBridgeError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof SignPreparationStateError) {
      const status = error.message.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }

    const message =
      error instanceof Error ? error.message : "Failed to save what you're making";
    console.error("Failed to confirm sign production type", error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("not found") ? 404 : 500 },
    );
  }
}
