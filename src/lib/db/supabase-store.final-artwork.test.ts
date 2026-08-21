import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { UniqueConstraintViolationError } from "./repository";
import { SupabaseProjectRepository } from "./supabase-store";

/**
 * Sprint 2M Phase 2B: verifies `SupabaseProjectRepository`'s
 * final-direction-approval / final-artwork-job query shapes against a fake
 * Postgrest client — no live Supabase infrastructure. Mirrors the fake
 * client style in `supabase-store.generation-jobs.test.ts`, scoped to just
 * the two new tables and their unique-constraint behavior.
 */

const POSTGRES_UNIQUE_VIOLATION = "23505";

interface FakeApprovalRow {
  id: string;
  project_id: string;
  artwork_version_id: string;
  design_brief_version_id: string;
  status: string;
  approved_at: string;
  superseded_at: string | null;
  created_at: string;
}

interface FakeJobRow {
  id: string;
  project_id: string;
  final_direction_approval_id: string;
  artwork_version_id: string;
  /** Sprint A2 Correction 2: the job's immutable bound production intent. */
  requested_production_output: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  provider_key: string | null;
  provider_request_id: string | null;
  provider_status: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeValidationRow {
  id: string;
  project_id: string;
  final_artwork_job_id: string;
  asset_id: string;
  status: string;
  report: Record<string, unknown>;
  validated_at: string;
  created_at: string;
}

function createFakeClient() {
  const approvals: FakeApprovalRow[] = [];
  const jobs: FakeJobRow[] = [];

  class ApprovalBuilder {
    private eqFilters: Array<{ col: string; val: unknown }> = [];
    constructor(
      private readonly op: "select" | "insert" | "update",
      private readonly payload: Record<string, unknown> | null = null,
    ) {}
    eq(col: string, val: unknown) {
      this.eqFilters.push({ col, val });
      return this;
    }
    select() {
      return this;
    }
    async maybeSingle() {
      return this.run();
    }
    async single() {
      return this.run();
    }
    private matches(row: FakeApprovalRow): boolean {
      return this.eqFilters.every(
        (f) => (row as unknown as Record<string, unknown>)[f.col] === f.val,
      );
    }
    /** Both `.maybeSingle()` and `.single()` return exactly one row (or `null`) here — this fake never needs to distinguish their zero/multiple-row error semantics. */
    private async run() {
      if (this.op === "select") {
        const matched = approvals.filter((r) => this.matches(r));
        return { data: matched[0] ?? null, error: null };
      }
      if (this.op === "insert") {
        const payload = this.payload!;
        if (payload.status === "active") {
          const conflict = approvals.some(
            (r) => r.project_id === payload.project_id && r.status === "active",
          );
          if (conflict) {
            return {
              data: null,
              error: { code: POSTGRES_UNIQUE_VIOLATION, message: "duplicate active approval" },
            };
          }
        }
        const row: FakeApprovalRow = {
          id: randomUUID(),
          project_id: payload.project_id as string,
          artwork_version_id: payload.artwork_version_id as string,
          design_brief_version_id: payload.design_brief_version_id as string,
          status: payload.status as string,
          approved_at: new Date().toISOString(),
          superseded_at: null,
          created_at: new Date().toISOString(),
        };
        approvals.push(row);
        return { data: row, error: null };
      }
      // update
      const matched = approvals.filter((r) => this.matches(r));
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched[0] ?? null, error: null };
    }
  }

  class JobBuilder {
    private eqFilters: Array<{ col: string; val: unknown }> = [];
    private inFilters: Array<{ col: string; vals: unknown[] }> = [];
    private ordered = false;
    private limitCount: number | null = null;
    constructor(
      private readonly op: "select" | "insert" | "update",
      private readonly payload: Record<string, unknown> | null = null,
    ) {}
    eq(col: string, val: unknown) {
      this.eqFilters.push({ col, val });
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilters.push({ col, vals });
      return this;
    }
    order() {
      this.ordered = true;
      return this;
    }
    limit(count: number) {
      this.limitCount = count;
      return this;
    }
    select() {
      return this;
    }
    async maybeSingle() {
      return this.run();
    }
    async single() {
      return this.run();
    }
    /**
     * Sprint A2 Correction 2: an approval may now own more than one job (one
     * per requested production output), so the store awaits the builder
     * directly for a ROW ARRAY instead of calling `.maybeSingle()`, which
     * throws on multiple rows against real Supabase. This makes the fake
     * thenable so it models that usage rather than only the single-row one.
     */
    then<TResult>(
      resolve: (value: { data: FakeJobRow[]; error: null }) => TResult,
    ): Promise<TResult> {
      return Promise.resolve(this.runList()).then(resolve);
    }
    private runList(): { data: FakeJobRow[]; error: null } {
      let matched = jobs.filter((r) => this.matches(r));
      if (this.ordered) {
        matched = [...matched].sort((a, b) => a.created_at.localeCompare(b.created_at));
      }
      if (this.limitCount !== null) matched = matched.slice(0, this.limitCount);
      return { data: matched, error: null };
    }
    private matches(row: FakeJobRow): boolean {
      const eqOk = this.eqFilters.every(
        (f) => (row as unknown as Record<string, unknown>)[f.col] === f.val,
      );
      const inOk = this.inFilters.every((f) =>
        f.vals.includes((row as unknown as Record<string, unknown>)[f.col]),
      );
      return eqOk && inOk;
    }
    private async run() {
      if (this.op === "select") {
        let matched = jobs.filter((r) => this.matches(r));
        if (this.ordered) matched = [...matched].sort((a, b) => a.created_at.localeCompare(b.created_at));
        if (this.limitCount !== null) matched = matched.slice(0, this.limitCount);
        return { data: matched[0] ?? null, error: null };
      }
      if (this.op === "update") {
        const matched = jobs.filter((r) => this.matches(r));
        for (const row of matched) Object.assign(row, this.payload);
        return { data: matched[0] ?? null, error: null };
      }
      const payload = this.payload!;
      // Sprint A2 Correction 2: mirrors the migration's coalesced unique
      // index — intent is part of job identity, so a PNG job and a
      // separations job for one approval are not duplicates of each other.
      const intentOf = (v: unknown) => (v as string | null) ?? "production_png";
      const conflict = jobs.some(
        (r) =>
          r.project_id === payload.project_id &&
          r.final_direction_approval_id === payload.final_direction_approval_id &&
          intentOf(r.requested_production_output) ===
            intentOf(payload.requested_production_output),
      );
      if (conflict) {
        return {
          data: null,
          error: { code: POSTGRES_UNIQUE_VIOLATION, message: "duplicate final artwork job" },
        };
      }
      const row: FakeJobRow = {
        id: randomUUID(),
        project_id: payload.project_id as string,
        final_direction_approval_id: payload.final_direction_approval_id as string,
        artwork_version_id: payload.artwork_version_id as string,
        requested_production_output:
          (payload.requested_production_output as string | null) ?? null,
        status: "queued",
        attempts: 0,
        last_error: null,
        started_at: null,
        completed_at: null,
        heartbeat_at: null,
        provider_key: null,
        provider_request_id: null,
        provider_status: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      jobs.push(row);
      return { data: row, error: null };
    }
  }

  let validationInsertCounter = 0;

  /** Minimal select/insert-only builder for `production_asset_validations` — no update/claim semantics needed. */
  class ValidationBuilder {
    private eqFilters: Array<{ col: string; val: unknown }> = [];
    private ordered = false;
    private limitCount: number | null = null;
    constructor(
      private readonly op: "select" | "insert",
      private readonly payload: Record<string, unknown> | null = null,
    ) {}
    eq(col: string, val: unknown) {
      this.eqFilters.push({ col, val });
      return this;
    }
    order() {
      this.ordered = true;
      return this;
    }
    limit(count: number) {
      this.limitCount = count;
      return this;
    }
    select() {
      return this;
    }
    async maybeSingle() {
      return this.run();
    }
    async single() {
      return this.run();
    }
    private matches(row: FakeValidationRow): boolean {
      return this.eqFilters.every(
        (f) => (row as unknown as Record<string, unknown>)[f.col] === f.val,
      );
    }
    private async run() {
      if (this.op === "select") {
        let matched = validations.filter((r) => this.matches(r));
        if (this.ordered) {
          matched = [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at));
        }
        if (this.limitCount !== null) matched = matched.slice(0, this.limitCount);
        return { data: matched[0] ?? null, error: null };
      }
      const payload = this.payload!;
      // A monotonic suffix guarantees `created_at` sorts correctly even
      // when two rows are inserted within the same millisecond (a real
      // risk in a fast-running test, unlike production traffic).
      validationInsertCounter += 1;
      const timestamp = `${new Date().toISOString()}.${String(validationInsertCounter).padStart(6, "0")}`;
      const row: FakeValidationRow = {
        id: randomUUID(),
        project_id: payload.project_id as string,
        final_artwork_job_id: payload.final_artwork_job_id as string,
        asset_id: payload.asset_id as string,
        status: payload.status as string,
        report: (payload.report as Record<string, unknown>) ?? {},
        validated_at: timestamp,
        created_at: timestamp,
      };
      validations.push(row);
      return { data: row, error: null };
    }
  }

  const validations: FakeValidationRow[] = [];

  const client = {
    from(table: string) {
      if (table === "final_direction_approvals") {
        return {
          select() {
            return new ApprovalBuilder("select");
          },
          insert(payload: Record<string, unknown>) {
            return new ApprovalBuilder("insert", payload);
          },
          update(payload: Record<string, unknown>) {
            return new ApprovalBuilder("update", payload);
          },
        };
      }
      if (table === "final_artwork_jobs") {
        return {
          select() {
            return new JobBuilder("select");
          },
          insert(payload: Record<string, unknown>) {
            return new JobBuilder("insert", payload);
          },
          update(payload: Record<string, unknown>) {
            return new JobBuilder("update", payload);
          },
        };
      }
      if (table === "production_asset_validations") {
        return {
          select() {
            return new ValidationBuilder("select");
          },
          insert(payload: Record<string, unknown>) {
            return new ValidationBuilder("insert", payload);
          },
        };
      }
      throw new Error(`fake client does not support table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, approvals, jobs, validations };
}

describe("SupabaseProjectRepository — final direction approval + final artwork job (Sprint 2M Phase 2B)", () => {
  it("creates an active approval and returns it via getActiveFinalDirectionApproval", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);

    const created = await repo.createFinalDirectionApproval("project-1", {
      artworkVersionId: "artwork-1",
      designBriefVersionId: "version-1",
    });
    assert.equal(created.status, "active");

    const active = await repo.getActiveFinalDirectionApproval("project-1");
    assert.equal(active?.id, created.id);
  });

  it("throws UniqueConstraintViolationError on a second simultaneous active approval for the same project", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);

    await repo.createFinalDirectionApproval("project-1", {
      artworkVersionId: "artwork-1",
      designBriefVersionId: "version-1",
    });

    await assert.rejects(
      () =>
        repo.createFinalDirectionApproval("project-1", {
          artworkVersionId: "artwork-2",
          designBriefVersionId: "version-1",
        }),
      UniqueConstraintViolationError,
    );
  });

  it("supersedeActiveFinalDirectionApproval marks the active row superseded and is a no-op when none is active", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);

    const created = await repo.createFinalDirectionApproval("project-1", {
      artworkVersionId: "artwork-1",
      designBriefVersionId: "version-1",
    });

    const superseded = await repo.supersedeActiveFinalDirectionApproval("project-1");
    assert.equal(superseded?.id, created.id);
    assert.equal(superseded?.status, "superseded");
    assert.equal(await repo.getActiveFinalDirectionApproval("project-1"), null);

    const noop = await repo.supersedeActiveFinalDirectionApproval("project-1");
    assert.equal(noop, null);
  });

  it("createFinalArtworkJob is unique per (project, approval) and throws on a duplicate", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);

    const approval = await repo.createFinalDirectionApproval("project-1", {
      artworkVersionId: "artwork-1",
      designBriefVersionId: "version-1",
    });

    const job = await repo.createFinalArtworkJob("project-1", {
      sourceKind: "generated_concept",
      finalDirectionApprovalId: approval.id,
      artworkVersionId: "artwork-1",
      requestedProductionOutput: "production_png",
      productionWidthIn: 10.5,
    });
    assert.equal(job.status, "queued");

    await assert.rejects(
      () =>
        repo.createFinalArtworkJob("project-1", {
          sourceKind: "generated_concept",
          finalDirectionApprovalId: approval.id,
          artworkVersionId: "artwork-1",
          requestedProductionOutput: "production_png",
          productionWidthIn: 10.5,
        }),
      UniqueConstraintViolationError,
    );

    const fetched = await repo.getFinalArtworkJobByApprovalId("project-1", approval.id);
    assert.equal(fetched?.id, job.id);
  });
});

describe("SupabaseProjectRepository — final artwork worker (Sprint 2M Phase 2C)", () => {
  async function createQueuedJob(repo: SupabaseProjectRepository) {
    const approval = await repo.createFinalDirectionApproval("project-1", {
      artworkVersionId: "artwork-1",
      designBriefVersionId: "version-1",
    });
    return repo.createFinalArtworkJob("project-1", {
      sourceKind: "generated_concept",
      finalDirectionApprovalId: approval.id,
      artworkVersionId: "artwork-1",
      requestedProductionOutput: "production_png",
      productionWidthIn: 10.5,
    });
  }

  it("claimNextQueuedFinalArtworkJob atomically claims the oldest queued job and bumps attempts", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);
    const job = await createQueuedJob(repo);

    const claimed = await repo.claimNextQueuedFinalArtworkJob();
    assert.equal(claimed?.id, job.id);
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.attempts, 1);
    assert.ok(claimed?.startedAt);
    assert.ok(claimed?.heartbeatAt);

    // Nothing left to claim.
    const second = await repo.claimNextQueuedFinalArtworkJob();
    assert.equal(second, null);
  });

  it("touchFinalArtworkJobHeartbeat and updateFinalArtworkJob mutate the expected fields", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);
    const job = await createQueuedJob(repo);
    await repo.claimNextQueuedFinalArtworkJob();

    await repo.touchFinalArtworkJobHeartbeat(job.id);
    const updated = await repo.updateFinalArtworkJob(job.id, {
      status: "completed",
      lastError: null,
      completedAt: new Date().toISOString(),
    });
    assert.equal(updated.status, "completed");
    assert.equal(updated.lastError, null);

    const fetched = await repo.getFinalArtworkJob(job.id);
    assert.equal(fetched?.status, "completed");
  });

  // Sprint 2M Phase 2E (Goal 3): the paid-call idempotency triple round-trips.
  it("updateFinalArtworkJob persists and round-trips the paid-call idempotency triple", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);
    const job = await createQueuedJob(repo);
    assert.equal(job.providerKey, null);
    assert.equal(job.providerRequestId, null);
    assert.equal(job.providerStatus, null);

    const updated = await repo.updateFinalArtworkJob(job.id, {
      providerKey: "topaz_transparency_upscale",
      providerRequestId: "topaz-process-id-123",
      providerStatus: "submitted",
    });
    assert.equal(updated.providerKey, "topaz_transparency_upscale");
    assert.equal(updated.providerRequestId, "topaz-process-id-123");
    assert.equal(updated.providerStatus, "submitted");

    const fetched = await repo.getFinalArtworkJob(job.id);
    assert.equal(fetched?.providerRequestId, "topaz-process-id-123");

    // Clearing (the "provider_job_failed" recovery path) round-trips too.
    const cleared = await repo.updateFinalArtworkJob(job.id, {
      providerKey: null,
      providerRequestId: null,
      providerStatus: null,
    });
    assert.equal(cleared.providerRequestId, null);
  });

  it("createProductionAssetValidation persists a row, and getLatestProductionAssetValidationForJob returns the most recent one", async () => {
    const { client } = createFakeClient();
    const repo = new SupabaseProjectRepository(client);
    const job = await createQueuedJob(repo);

    const first = await repo.createProductionAssetValidation("project-1", {
      finalArtworkJobId: job.id,
      assetId: "asset-1",
      status: "finalization_required",
      report: { status: "finalization_required", checks: [] },
    });
    assert.equal(first.status, "finalization_required");

    const second = await repo.createProductionAssetValidation("project-1", {
      finalArtworkJobId: job.id,
      assetId: "asset-1",
      status: "ready",
      report: { status: "ready", checks: [] },
    });

    const latest = await repo.getLatestProductionAssetValidationForJob("project-1", job.id);
    assert.equal(latest?.id, second.id);
    assert.equal(latest?.status, "ready");
    assert.notEqual(latest?.id, first.id);
  });
});
