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
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
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
    constructor(
      private readonly op: "select" | "insert",
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
    private matches(row: FakeJobRow): boolean {
      return this.eqFilters.every(
        (f) => (row as unknown as Record<string, unknown>)[f.col] === f.val,
      );
    }
    private async run() {
      if (this.op === "select") {
        const matched = jobs.filter((r) => this.matches(r));
        return { data: matched[0] ?? null, error: null };
      }
      const payload = this.payload!;
      const conflict = jobs.some(
        (r) =>
          r.project_id === payload.project_id &&
          r.final_direction_approval_id === payload.final_direction_approval_id,
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
        status: "queued",
        last_error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      jobs.push(row);
      return { data: row, error: null };
    }
  }

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
        };
      }
      throw new Error(`fake client does not support table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, approvals, jobs };
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
      finalDirectionApprovalId: approval.id,
      artworkVersionId: "artwork-1",
    });
    assert.equal(job.status, "queued");

    await assert.rejects(
      () =>
        repo.createFinalArtworkJob("project-1", {
          finalDirectionApprovalId: approval.id,
          artworkVersionId: "artwork-1",
        }),
      UniqueConstraintViolationError,
    );

    const fetched = await repo.getFinalArtworkJobByApprovalId("project-1", approval.id);
    assert.equal(fetched?.id, job.id);
  });
});
