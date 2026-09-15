/**
 * Phase R5: the provider-neutral boundary a `RasterReconstructionProvider`
 * implements. A provider owns GENERATIVE RECONSTRUCTION ONLY — it must
 * never decide candidate acceptance, Print Ready, sign/DTF sizing, or
 * customer approval (see `RasterReconstructionCapability`'s own doc
 * comment for the full "must not" list).
 *
 * Unlike `TopazTransparencyUpscaleProvider`'s submit/poll/download async
 * job shape, an OpenAI `/v1/images/edits` call is one synchronous HTTP
 * round-trip: there is no separate "resume an in-flight request" concept
 * for this provider family, because the provider itself offers no way to
 * fetch a previous edit's result by request id. `reconstruct()` therefore
 * either succeeds with real bytes or throws — see
 * `RasterReconstructionWorkerCapability`'s own doc comment for how it
 * still avoids most (not all — an honest, documented v1 limitation)
 * duplicate-spend risk despite that.
 */

import type { RasterReconstructionRequest, RasterReconstructionResult } from "./contracts";

export interface RasterReconstructionProvider {
  readonly providerKey: string;
  reconstruct(request: RasterReconstructionRequest): Promise<RasterReconstructionResult>;
}
