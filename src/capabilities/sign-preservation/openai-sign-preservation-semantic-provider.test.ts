import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProviderError } from "@/capabilities/providers/provider-error";
import type {
  CreateSignPreservationTransportAttemptInput,
  UpdateSignPreservationTransportAttemptInput,
} from "@/lib/db/repository";
import type { SignPreservationTransportAttempt } from "@/lib/domain/types";

import { SIGN_PRESERVATION_SEMANTIC_CATEGORIES } from "./contracts";
import { OpenAISignPreservationSemanticProvider } from "./openai-sign-preservation-semantic-provider";
import {
  SignPreservationTransportAttemptConflictError,
  type SignPreservationTransportAttemptStore,
} from "./sign-preservation-transport-attempt-store";
import type { SignPreservationSemanticRequest } from "./sign-preservation-semantic-provider";

/**
 * Signs Phase S4.2C.1: request-building / response-parsing / error-
 * classification / UPLOAD-GATE-CLEANUP-RECOVERY coverage for the real
 * OpenAI Files-transport adapter — via injected fake `fetchImpl` and an
 * in-memory `SignPreservationTransportAttemptStore` ONLY. No test in this
 * file, or anywhere in this repository, ever constructs this class with a
 * real API key or lets a real network request leave the process.
 */

function image(label: string) {
  return { dataUri: `data:image/png;base64,${Buffer.from(label).toString("base64")}`, label };
}

function sampleRequest(overrides?: Partial<SignPreservationSemanticRequest>): SignPreservationSemanticRequest {
  return {
    sourceOverview: image("source overview"),
    reconstructionOverview: image("reconstruction overview"),
    sourceCrops: Array.from({ length: 6 }, (_, i) => image(`source crop ${i}`)),
    reconstructionCrops: Array.from({ length: 6 }, (_, i) => image(`reconstruction crop ${i}`)),
    idempotencyKey: "test-identity-key",
    verificationIdentity: {
      projectId: "project-1",
      finalAssetId: "final-asset-1",
      sourceAssetId: "source-asset-1",
      intermediateAssetId: "intermediate-asset-1",
      planKey: "plan-key-1",
      combinedVerificationAlgorithmVersion: "combined-identity-1",
    },
    ...overrides,
  };
}

function allSameAnswers() {
  return SIGN_PRESERVATION_SEMANTIC_CATEGORIES.map((category) => ({
    category,
    answer: "same",
    reason: "unchanged",
    regionReference: null,
  }));
}

function responsesApiResponse(body: unknown, status = 200, id = "resp_test_1"): Response {
  return new Response(
    JSON.stringify({
      id,
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 1234, output_tokens: 56 },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** In-memory double for the durable transport-attempt store — mirrors `LocalProjectRepository`'s own identity/mutation semantics exactly, at a scale small enough to inline in this test file. */
function createInMemoryTransportAttemptStore(): SignPreservationTransportAttemptStore & {
  rows: SignPreservationTransportAttempt[];
} {
  const rows: SignPreservationTransportAttempt[] = [];
  let seq = 0;
  return {
    rows,
    async get(finalAssetId, combinedVersion) {
      return (
        rows.find(
          (r) => r.finalAssetId === finalAssetId && r.combinedVerificationAlgorithmVersion === combinedVersion,
        ) ?? null
      );
    },
    async create(projectId, input: CreateSignPreservationTransportAttemptInput) {
      if (
        rows.some(
          (r) =>
            r.finalAssetId === input.finalAssetId &&
            r.combinedVerificationAlgorithmVersion === input.combinedVerificationAlgorithmVersion,
        )
      ) {
        throw new Error("duplicate transport attempt identity");
      }
      seq += 1;
      const now = new Date().toISOString();
      const row: SignPreservationTransportAttempt = {
        id: `attempt-${seq}`,
        projectId,
        finalAssetId: input.finalAssetId,
        sourceAssetId: input.sourceAssetId,
        intermediateAssetId: input.intermediateAssetId,
        planKey: input.planKey,
        combinedVerificationAlgorithmVersion: input.combinedVerificationAlgorithmVersion,
        transportVersion: input.transportVersion,
        status: "in_progress",
        files: [],
        inferenceDispatchedAt: null,
        inferenceOutcome: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    },
    async update(id, input: UpdateSignPreservationTransportAttemptInput) {
      const index = rows.findIndex((r) => r.id === id);
      if (index === -1) throw new Error(`no in-memory transport attempt with id ${id}`);
      const current = rows[index];
      const updated: SignPreservationTransportAttempt = {
        ...current,
        status: input.status ?? current.status,
        files: input.files ?? current.files,
        inferenceDispatchedAt:
          input.inferenceDispatchedAt !== undefined ? input.inferenceDispatchedAt : current.inferenceDispatchedAt,
        inferenceOutcome: input.inferenceOutcome !== undefined ? input.inferenceOutcome : current.inferenceOutcome,
        updatedAt: new Date().toISOString(),
      };
      rows[index] = updated;
      return updated;
    },
  };
}

interface CallLog {
  uploadCalls: { form: FormData }[];
  deleteCalls: { fileId: string }[];
  responsesCalls: { body: Record<string, unknown> }[];
}

function createRoutedFetch(overrides?: {
  respondToUpload?: (form: FormData, index: number) => Response | Promise<Response>;
  respondToDelete?: (fileId: string, index: number) => Response | Promise<Response>;
  respondToResponses?: (body: Record<string, unknown>, index: number) => Response | Promise<Response>;
}): { fetchImpl: typeof fetch; log: CallLog } {
  const log: CallLog = { uploadCalls: [], deleteCalls: [], responsesCalls: [] };
  let fileSeq = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "https://api.openai.com/v1/files" && method === "POST") {
      const form = init!.body as FormData;
      log.uploadCalls.push({ form });
      if (overrides?.respondToUpload) return overrides.respondToUpload(form, log.uploadCalls.length - 1);
      fileSeq += 1;
      return new Response(JSON.stringify({ id: `file-${fileSeq}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.startsWith("https://api.openai.com/v1/files/") && method === "DELETE") {
      const fileId = decodeURIComponent(url.split("/").pop()!);
      log.deleteCalls.push({ fileId });
      if (overrides?.respondToDelete) return overrides.respondToDelete(fileId, log.deleteCalls.length - 1);
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url === "https://api.openai.com/v1/responses" && method === "POST") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      log.responsesCalls.push({ body });
      if (overrides?.respondToResponses) return overrides.respondToResponses(body, log.responsesCalls.length - 1);
      return responsesApiResponse({ answers: allSameAnswers() });
    }

    throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
  }) as typeof fetch;

  return { fetchImpl, log };
}

function makeProvider(fetchImpl: typeof fetch, store: SignPreservationTransportAttemptStore, extra?: object) {
  return new OpenAISignPreservationSemanticProvider({
    apiKey: "sk-test",
    model: "gpt-5.6-sol",
    transportAttemptStore: store,
    fetchImpl,
    sleepImpl: async () => {},
    ...extra,
  });
}

describe("OpenAISignPreservationSemanticProvider — construction", () => {
  it("throws immediately if constructed without an API key", () => {
    assert.throws(
      () =>
        new OpenAISignPreservationSemanticProvider({
          apiKey: "",
          model: "gpt-5.6-sol",
          transportAttemptStore: createInMemoryTransportAttemptStore(),
        }),
      /API key/,
    );
  });

  it("modelIdentity/providerKey/transportVersion are all exposed correctly — every combined-identity component", () => {
    const provider = makeProvider((async () => new Response()) as typeof fetch, createInMemoryTransportAttemptStore());
    assert.equal(provider.modelIdentity, "gpt-5.6-sol");
    assert.equal(provider.providerKey, "openai_sign_preservation_semantic");
    assert.equal(provider.transportVersion, "sign-preservation-transport:file-id-v1");
  });
});

describe("OpenAISignPreservationSemanticProvider — file upload transport", () => {
  it("uploads exactly 14 images before ever calling the Responses endpoint", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());
    assert.equal(log.uploadCalls.length, 14);
    assert.equal(log.responsesCalls.length, 1);
  });

  it("every upload is genuine multipart/form-data (a real FormData body), not JSON", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());
    for (const call of log.uploadCalls) {
      assert.ok(call.form instanceof FormData, "upload body must be a real FormData instance");
    }
  });

  it("every upload sets purpose=user_data", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());
    for (const call of log.uploadCalls) {
      assert.equal(call.form.get("purpose"), "user_data");
    }
  });

  it("every upload includes an explicit expires_after using OpenAI's documented bracket-notation multipart fields (Signs Phase S4.2C.3 fix)", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());
    for (const call of log.uploadCalls) {
      // The real S4.2C.2 smoke test's HTTP 400 root cause — a single
      // JSON-stringified `expires_after` field — must never reappear.
      assert.equal(call.form.get("expires_after"), null, "no plain JSON-stringified expires_after field may exist");
      assert.equal(call.form.get("expires_after[anchor]"), "created_at");
      assert.equal(call.form.get("expires_after[seconds]"), "3600");
    }
  });

  it("every upload has a real file field alongside purpose and expires_after", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());
    for (const call of log.uploadCalls) {
      assert.equal(call.form.get("purpose"), "user_data");
      assert.ok(call.form.get("file") instanceof File, "a file field must be present");
      assert.ok(call.form.get("expires_after[anchor]"));
      assert.ok(call.form.get("expires_after[seconds]"));
    }
  });

  it("filenames are deterministic and carry no customer-identifying text", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());
    const filenames = log.uploadCalls.map((c) => (c.form.get("file") as File).name);
    assert.equal(filenames.length, 14);
    assert.equal(new Set(filenames).size, 14, "every filename is unique");
    for (const name of filenames) {
      assert.match(name, /^sign-preservation-/);
      assert.doesNotMatch(name.toLowerCase(), /ruth|ptp|customer/);
    }
  });

  it("an upload response missing a valid file id -> malformed_response, zero Responses calls", async () => {
    const { fetchImpl, log } = createRoutedFetch({
      respondToUpload: () =>
        new Response(JSON.stringify({ notAnId: true }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "malformed_response");
      return true;
    });
    assert.equal(log.responsesCalls.length, 0, "inference must never be reached when an upload is invalid");
  });

  it("Signs Phase S4.2C.3: a non-2xx upload response's error body/request-id are surfaced (bounded), reproducing the real S4.2C.2 HTTP 400 as an actionable message", async () => {
    const { fetchImpl } = createRoutedFetch({
      respondToUpload: () =>
        new Response(JSON.stringify({ error: { message: "Invalid value for 'expires_after'.", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json", "x-request-id": "req_smoke_test_123" },
        }),
    });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "malformed_response");
      assert.match(err.message, /req_smoke_test_123/, "the provider request id must be surfaced");
      assert.match(err.message, /Invalid value for 'expires_after'/, "the provider's own error detail must be surfaced");
      return true;
    });
  });

  it("Signs Phase S4.2C.3: a very long error body is truncated to a bounded length, never logged in full", async () => {
    const hugeBody = JSON.stringify({ error: { message: "x".repeat(5000) } });
    const { fetchImpl } = createRoutedFetch({
      respondToUpload: () => new Response(hugeBody, { status: 400, headers: { "content-type": "application/json" } }),
    });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.ok(err.message.length < hugeBody.length, "the full 5000-char body must never appear verbatim in the error message");
      return true;
    });
  });

  it("Signs Phase S4.2C.3: an upload error message never contains the Authorization header, the bearer token, or any multipart content", async () => {
    const { fetchImpl } = createRoutedFetch({ respondToUpload: () => new Response("plain text failure, no json", { status: 400 }) });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.doesNotMatch(err.message, /sk-test/);
      assert.doesNotMatch(err.message, /Bearer/i);
      assert.doesNotMatch(err.message, /authorization/i);
      return true;
    });
  });

  it("an upload transport failure aborts before any Responses call", async () => {
    const { fetchImpl, log } = createRoutedFetch({
      respondToUpload: (_form, index) => {
        if (index === 3) throw new Error("simulated network failure");
        return new Response(JSON.stringify({ id: `file-${index}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await assert.rejects(() => provider.compare(sampleRequest()));
    assert.equal(log.responsesCalls.length, 0);
  });
});

describe("OpenAISignPreservationSemanticProvider — upload idempotency / crash recovery", () => {
  it("a crash after some uploads resumes only the remaining images on the next attempt — never re-uploads a completed role", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();

    const crashing = createRoutedFetch({
      respondToUpload: (_form, index) => {
        if (index === 7) throw new Error("simulated crash mid-upload");
        return new Response(JSON.stringify({ id: `first-${index}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const firstProvider = makeProvider(crashing.fetchImpl, store);
    await assert.rejects(() => firstProvider.compare(request));
    assert.equal(crashing.log.uploadCalls.length, 8, "7 succeeded, the 8th threw");

    const resuming = createRoutedFetch();
    const secondProvider = makeProvider(resuming.fetchImpl, store);
    const result = await secondProvider.compare(request);

    assert.equal(resuming.log.uploadCalls.length, 7, "only the remaining 7 roles were uploaded — the first 7 were reused");
    assert.equal(resuming.log.responsesCalls.length, 1);
    assert.ok(result.answers.length > 0);
  });

  it("a content-hash mismatch forces a fresh upload for that exact role, even if a stale file id already exists", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();

    // Pre-seed a stale/mismatched record for "source_overview" only.
    const seeded = await store.create(request.verificationIdentity.projectId, {
      finalAssetId: request.verificationIdentity.finalAssetId,
      sourceAssetId: request.verificationIdentity.sourceAssetId,
      intermediateAssetId: request.verificationIdentity.intermediateAssetId,
      planKey: request.verificationIdentity.planKey,
      combinedVerificationAlgorithmVersion: request.verificationIdentity.combinedVerificationAlgorithmVersion,
      transportVersion: "sign-preservation-transport:file-id-v1",
    });
    await store.update(seeded.id, {
      files: [
        {
          role: "source_overview",
          contentHash: "stale-hash-does-not-match-current-derivation",
          providerFileId: "stale-file-id",
          uploadCompletedAt: new Date().toISOString(),
          cleanupCompletedAt: null,
        },
      ],
    });

    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, store);
    await provider.compare(request);

    assert.equal(log.uploadCalls.length, 14, "the stale role was re-uploaded, not reused, alongside the other 13");
    const finalRow = await store.get(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    const sourceOverviewRecord = finalRow!.files.find((f) => f.role === "source_overview")!;
    assert.notEqual(sourceOverviewRecord.providerFileId, "stale-file-id");
  });

  it("the inference gate: with all 14 roles already uploaded and matching, a fresh compare() call skips every upload and dispatches directly", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();

    // First run: uploads all 14, completes, cleans up.
    const first = createRoutedFetch();
    const firstProvider = makeProvider(first.fetchImpl, store);
    await firstProvider.compare(request);

    // A different verification identity re-using the SAME derived images —
    // simulates a fresh attempt that would otherwise re-derive identical
    // content. Pre-seed its store row with the already-uploaded (still
    // live) file ids by copying the first attempt's OWN uploaded ids
    // before cleanup would have redacted them, proving the gate accepts
    // a fully-satisfied set without re-uploading anything.
    const request2 = sampleRequest({
      verificationIdentity: {
        ...request.verificationIdentity,
        combinedVerificationAlgorithmVersion: "combined-identity-2",
      },
    });
    const seeded = await store.create(request2.verificationIdentity.projectId, {
      finalAssetId: request2.verificationIdentity.finalAssetId,
      sourceAssetId: request2.verificationIdentity.sourceAssetId,
      intermediateAssetId: request2.verificationIdentity.intermediateAssetId,
      planKey: request2.verificationIdentity.planKey,
      combinedVerificationAlgorithmVersion: request2.verificationIdentity.combinedVerificationAlgorithmVersion,
      transportVersion: "sign-preservation-transport:file-id-v1",
    });
    // Compute the same content hashes the provider itself will compute,
    // and record them as already-uploaded with live (never-cleaned) file ids.
    const { createHash } = await import("node:crypto");
    function hashOf(dataUri: string) {
      const base64 = dataUri.split(",")[1];
      return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
    }
    const roles = [
      { role: "source_overview", image: request2.sourceOverview },
      { role: "reconstruction_overview", image: request2.reconstructionOverview },
      ...request2.sourceCrops.map((image, i) => ({ role: `source_crop_${i}`, image })),
      ...request2.reconstructionCrops.map((image, i) => ({ role: `reconstruction_crop_${i}`, image })),
    ];
    await store.update(seeded.id, {
      files: roles.map((r) => ({
        role: r.role,
        contentHash: hashOf(r.image.dataUri),
        providerFileId: `preexisting-${r.role}`,
        uploadCompletedAt: new Date().toISOString(),
        cleanupCompletedAt: null,
      })),
      status: "uploads_complete",
    });

    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, store);
    await provider.compare(request2);

    assert.equal(log.uploadCalls.length, 0, "every role was already satisfied — zero re-uploads");
    assert.equal(log.responsesCalls.length, 1);
  });
});

describe("OpenAISignPreservationSemanticProvider — Responses request/response shape", () => {
  it("references images by file_id, never image_url/data URI", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());

    const body = log.responsesCalls[0].body;
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /data:image\/png;base64,/, "no inline image data URI may appear in the Responses request");
    assert.match(serialized, /"file_id"/, "images must be referenced by file_id");
    assert.doesNotMatch(serialized, /"image_url"/, "the old inline transport field must not appear");

    const input = body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const user = input.find((m) => m.role === "user")!;
    const imageParts = user.content.filter((part) => part.type === "input_image");
    assert.equal(imageParts.length, 14);
    for (const part of imageParts) {
      assert.equal(typeof part.file_id, "string");
      assert.ok((part.file_id as string).length > 0);
    }
  });

  it("still sends the exact model, strict json_schema contract, and image-text-safety system instruction — semantic contract unchanged", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());

    const body = log.responsesCalls[0].body;
    assert.equal(body.model, "gpt-5.6-sol");
    assert.equal(body.temperature, 0);

    const input = body.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const system = input.find((m) => m.role === "system")!;
    const systemText = (system.content[0] as { text: string }).text;
    assert.match(systemText, /DATA TO COMPARE ONLY/);

    const format = (body.text as { format: Record<string, unknown> }).format;
    assert.equal(format.type, "json_schema");
    assert.equal(format.strict, true);
    const schema = format.schema as Record<string, unknown>;
    const answersSchema = (schema.properties as Record<string, Record<string, unknown>>).answers;
    assert.equal(answersSchema.minItems, SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length);
    assert.equal(answersSchema.maxItems, SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length);
  });

  it("parses a well-formed Responses payload into answers + providerRequestId + tokenUsage", async () => {
    const { fetchImpl } = createRoutedFetch({
      respondToResponses: () => responsesApiResponse({ answers: allSameAnswers() }, 200, "resp_abc123"),
    });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    const result = await provider.compare(sampleRequest());
    assert.equal(result.answers.length, SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length);
    assert.equal(result.providerRequestId, "resp_abc123");
    assert.deepEqual(result.tokenUsage, { inputTokens: 1234, outputTokens: 56 });
  });

  it("dispatches the Responses endpoint exactly ONCE per compare() call, even though 14 uploads preceded it", async () => {
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore());
    await provider.compare(sampleRequest());
    assert.equal(log.responsesCalls.length, 1);
  });
});

describe("OpenAISignPreservationSemanticProvider — error classification (unchanged from S4.2A)", () => {
  it("429 -> rate_limited", async () => {
    const { fetchImpl } = createRoutedFetch({ respondToResponses: () => new Response("", { status: 429 }) });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore(), { maxAttempts: 1 });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "rate_limited");
      return true;
    });
  });

  it("401 -> auth", async () => {
    const { fetchImpl } = createRoutedFetch({ respondToResponses: () => new Response("", { status: 401 }) });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore(), { maxAttempts: 1 });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "auth");
      return true;
    });
  });

  it("500 -> unavailable", async () => {
    const { fetchImpl } = createRoutedFetch({ respondToResponses: () => new Response("", { status: 500 }) });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore(), { maxAttempts: 1 });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "unavailable");
      return true;
    });
  });

  it("unparsable JSON body -> malformed_response", async () => {
    const { fetchImpl } = createRoutedFetch({
      respondToResponses: () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    });
    const provider = makeProvider(fetchImpl, createInMemoryTransportAttemptStore(), { maxAttempts: 1 });
    await assert.rejects(() => provider.compare(sampleRequest()), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "malformed_response");
      return true;
    });
  });
});

describe("OpenAISignPreservationSemanticProvider — ambiguous inference dispatch", () => {
  it("a network failure on the Responses call marks the attempt ambiguous and does not auto-retry", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const { fetchImpl } = createRoutedFetch({
      respondToResponses: () => {
        throw new Error("simulated ambiguous network failure");
      },
    });
    const provider = makeProvider(fetchImpl, store, { maxAttempts: 1 });
    await assert.rejects(() => provider.compare(request), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.classification, "network");
      assert.equal(err.dispatch, "dispatched_ambiguous");
      return true;
    });

    const row = await store.get(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(row!.status, "inference_dispatched_ambiguous");
    assert.equal(row!.inferenceOutcome, "dispatched_ambiguous");
    // Files must NOT be cleaned up for an ambiguous dispatch.
    assert.ok(row!.files.every((f) => f.providerFileId !== null));
  });

  it("calling compare() again for the SAME ambiguous identity refuses to dispatch a second inference", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const failing = createRoutedFetch({
      respondToResponses: () => {
        throw new Error("simulated ambiguous network failure");
      },
    });
    const firstProvider = makeProvider(failing.fetchImpl, store, { maxAttempts: 1 });
    await assert.rejects(() => firstProvider.compare(request));
    assert.equal(failing.log.responsesCalls.length, 1);

    const second = createRoutedFetch();
    const secondProvider = makeProvider(second.fetchImpl, store);
    await assert.rejects(
      () => secondProvider.compare(request),
      (err: unknown) => {
        assert.ok(err instanceof SignPreservationTransportAttemptConflictError);
        return true;
      },
    );
    assert.equal(second.log.responsesCalls.length, 0, "no second paid dispatch was ever attempted");
    assert.equal(second.log.uploadCalls.length, 0, "not even a re-upload was attempted");
  });

  it("calling compare() again after a COMPLETED (but somehow unpersisted) identity also refuses to re-dispatch", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const first = createRoutedFetch();
    const firstProvider = makeProvider(first.fetchImpl, store);
    await firstProvider.compare(request);
    assert.equal(first.log.responsesCalls.length, 1);

    const second = createRoutedFetch();
    const secondProvider = makeProvider(second.fetchImpl, store);
    await assert.rejects(
      () => secondProvider.compare(request),
      (err: unknown) => {
        assert.ok(err instanceof SignPreservationTransportAttemptConflictError);
        return true;
      },
    );
    assert.equal(second.log.responsesCalls.length, 0);
  });
});

describe("OpenAISignPreservationSemanticProvider — cleanup lifecycle", () => {
  it("a successful inference cleans up (deletes) all 14 uploaded files", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const { fetchImpl, log } = createRoutedFetch();
    const provider = makeProvider(fetchImpl, store);
    await provider.compare(request);

    assert.equal(log.deleteCalls.length, 14);
    const row = await store.get(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(row!.status, "cleanup_complete");
    assert.ok(row!.files.every((f) => f.providerFileId === null), "provider file ids are redacted after cleanup");
    assert.ok(row!.files.every((f) => f.cleanupCompletedAt !== null));
  });

  it("a definite (non-ambiguous) inference failure — e.g. malformed_response — still cleans up all 14 uploaded files", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const { fetchImpl, log } = createRoutedFetch({
      respondToResponses: () =>
        new Response(JSON.stringify({ id: "resp_1", output: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const provider = makeProvider(fetchImpl, store, { maxAttempts: 1 });
    await assert.rejects(() => provider.compare(request));

    assert.equal(log.deleteCalls.length, 14, "a definite failure still triggers cleanup");
    const row = await store.get(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(row!.inferenceOutcome, "failed_pre_dispatch");
    assert.equal(row!.status, "cleanup_complete");
  });

  it("a cleanup delete failure does NOT hide a completed semantic result — compare() still resolves successfully", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const { fetchImpl, log } = createRoutedFetch({
      respondToDelete: (_fileId, index) => {
        if (index === 2) return new Response("", { status: 500 });
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const provider = makeProvider(fetchImpl, store);
    const result = await provider.compare(request);

    assert.equal(result.answers.length, SIGN_PRESERVATION_SEMANTIC_CATEGORIES.length, "the semantic result is returned despite the cleanup failure");
    const row = await store.get(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.notEqual(row!.status, "cleanup_complete", "status stays short of complete while one file remains undeleted");
    const uncleanedCount = row!.files.filter((f) => f.providerFileId !== null).length;
    assert.equal(uncleanedCount, 1, "exactly the one failed delete is recorded for retry");
    assert.equal(log.deleteCalls.length, 14, "every file was still attempted");
  });

  it("recoverCleanup retries only the previously-undeleted files, and is idempotent", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    let failDeleteOnce = true;
    const first = createRoutedFetch({
      respondToDelete: (_fileId, index) => {
        if (index === 5 && failDeleteOnce) {
          failDeleteOnce = false;
          return new Response("", { status: 500 });
        }
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const provider = makeProvider(first.fetchImpl, store);
    await provider.compare(request);
    const row = await store.get(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(row!.files.filter((f) => f.providerFileId !== null).length, 1);

    const second = createRoutedFetch();
    const recoveryProvider = makeProvider(second.fetchImpl, store);
    const recovered = await recoveryProvider.recoverCleanup(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(second.log.deleteCalls.length, 1, "only the one previously-undeleted file was retried");
    assert.equal(recovered.allCleaned, true);
    assert.equal(recovered.attempt.status, "cleanup_complete");

    // Idempotent: calling it again finds nothing left to delete.
    const third = createRoutedFetch();
    const idempotentRecovery = await recoveryProvider.recoverCleanup(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(third.log.deleteCalls.length, 0);
    assert.equal(idempotentRecovery.allCleaned, true);
  });

  it("a 404 on delete is treated as already-deleted, never an error (idempotency at the transport layer)", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const { fetchImpl } = createRoutedFetch({ respondToDelete: () => new Response("", { status: 404 }) });
    const provider = makeProvider(fetchImpl, store);
    const result = await provider.compare(request);
    assert.ok(result.answers.length > 0, "a 404-on-delete never surfaces as a compare() failure");
    const row = await store.get(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(row!.status, "cleanup_complete");
  });

  it("recoverCleanup never touches files for an attempt still classified ambiguous", async () => {
    const store = createInMemoryTransportAttemptStore();
    const request = sampleRequest();
    const failing = createRoutedFetch({
      respondToResponses: () => {
        throw new Error("simulated ambiguous network failure");
      },
    });
    const provider = makeProvider(failing.fetchImpl, store, { maxAttempts: 1 });
    await assert.rejects(() => provider.compare(request));

    const { fetchImpl: recoveryFetch, log: recoveryLog } = createRoutedFetch();
    const recoveryProvider = makeProvider(recoveryFetch, store);
    const recovered = await recoveryProvider.recoverCleanup(
      request.verificationIdentity.finalAssetId,
      request.verificationIdentity.combinedVerificationAlgorithmVersion,
    );
    assert.equal(recoveryLog.deleteCalls.length, 0, "an ambiguous attempt's files are never touched by recovery cleanup");
    assert.equal(recovered.allCleaned, false);
  });
});
