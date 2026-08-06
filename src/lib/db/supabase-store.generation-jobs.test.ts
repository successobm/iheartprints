import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SupabaseProjectRepository } from "./supabase-store";

/**
 * Sprint 2H Part 2B: verifies `SupabaseProjectRepository`'s atomic-claim and
 * recovery query shapes against a fake Postgrest client — no live Supabase
 * infrastructure. The fake evaluates each builder's filters against live
 * table state at the moment it actually executes (not a snapshot taken
 * earlier), exactly mirroring how a real `UPDATE ... WHERE` evaluates
 * against the current row in Postgres. That's what makes the concurrency
 * test below a meaningful simulation of two real workers racing, not just a
 * shape check: single-threaded JS interleaves the two repositories' awaited
 * calls the same way two real requests would interleave at the database.
 */

interface FakeRow {
  id: string;
  status: string;
  attempts: number;
  heartbeat_at: string | null;
  started_at: string | null;
  updated_at: string;
  created_at: string;
  [key: string]: unknown;
}

function matchesStaleOrExpr(row: FakeRow, expr: string): boolean {
  // Only ever called with the exact shape `recoverAbandonedJobs` builds:
  // and(heartbeat_at.is.null,started_at.lt.<iso>),heartbeat_at.lt.<iso>
  const staleBefore = expr.match(/lt\.([^,)]+)/)?.[1] ?? "";
  const heartbeatNull = row.heartbeat_at === null;
  const startedStale = row.started_at !== null && row.started_at < staleBefore;
  const heartbeatStale = row.heartbeat_at !== null && row.heartbeat_at < staleBefore;
  return (heartbeatNull && startedStale) || heartbeatStale;
}

type RecordedCall = {
  op: "select" | "update";
  eq: Array<{ col: string; val: unknown }>;
  in?: { col: string; vals: unknown[] };
  or?: string;
};

function createFakeGenerationJobsClient(initialRows: FakeRow[]) {
  const rows: FakeRow[] = initialRows.map((r) => ({ ...r }));
  const calls: RecordedCall[] = [];

  class Builder {
    private eqFilters: Array<{ col: string; val: unknown }> = [];
    private inFilter: { col: string; vals: unknown[] } | null = null;
    private orExpr: string | null = null;
    private orderCol: { col: string; ascending: boolean } | null = null;
    private limitN: number | null = null;

    constructor(
      private readonly op: "select" | "update",
      private readonly payload: Record<string, unknown> | null = null,
    ) {}

    eq(col: string, val: unknown) {
      this.eqFilters.push({ col, val });
      return this;
    }
    in(col: string, vals: unknown[]) {
      this.inFilter = { col, vals };
      return this;
    }
    or(expr: string) {
      this.orExpr = expr;
      return this;
    }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orderCol = { col, ascending: opts?.ascending ?? true };
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    select() {
      return this;
    }
    async maybeSingle() {
      const { data, error } = await this.run();
      const arr = (data as FakeRow[]) ?? [];
      return { data: arr[0] ?? null, error };
    }
    async single() {
      const { data, error } = await this.run();
      const arr = (data as FakeRow[]) ?? [];
      return { data: arr[0] ?? null, error };
    }
    then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.run().then(onfulfilled, onrejected);
    }

    private matchesRow(row: FakeRow): boolean {
      for (const f of this.eqFilters) if (row[f.col] !== f.val) return false;
      if (this.inFilter && !this.inFilter.vals.includes(row[this.inFilter.col])) {
        return false;
      }
      if (this.orExpr && !matchesStaleOrExpr(row, this.orExpr)) return false;
      return true;
    }

    private async run(): Promise<{ data: unknown; error: null }> {
      calls.push({
        op: this.op,
        eq: this.eqFilters,
        in: this.inFilter ?? undefined,
        or: this.orExpr ?? undefined,
      });

      // Yield a microtask so two concurrently-issued builders genuinely
      // interleave (both SELECTs resolve before either UPDATE runs),
      // matching how two real HTTP round-trips to Postgres would race.
      await Promise.resolve();

      let matched = rows.filter((r) => this.matchesRow(r));

      if (this.op === "update" && this.payload) {
        // Evaluated against *live* table state at execution time — a row
        // mutated by a concurrent call between this builder's construction
        // and its execution is picked up here, exactly like a real
        // `UPDATE ... WHERE` re-checks its predicate against current rows.
        for (const row of matched) Object.assign(row, this.payload);
      }

      if (this.orderCol) {
        const { col, ascending } = this.orderCol;
        matched = [...matched].sort((a, b) => {
          const av = String(a[col]);
          const bv = String(b[col]);
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (this.limitN != null) matched = matched.slice(0, this.limitN);

      return { data: matched, error: null };
    }
  }

  const client = {
    from(table: string) {
      if (table !== "generation_jobs") {
        throw new Error(`fake client does not support table ${table}`);
      }
      return {
        select() {
          return new Builder("select");
        },
        update(payload: Record<string, unknown>) {
          return new Builder("update", payload);
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, rows, calls };
}

function makeRow(overrides: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    status: "queued",
    attempts: 0,
    heartbeat_at: null,
    started_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    project_id: "project-1",
    design_brief_version_id: "brief-1",
    kind: "initial",
    concept_count: 3,
    provider_key: "placeholder",
    idempotency_key: `key-${overrides.id}`,
    last_error: null,
    completed_at: null,
    ...overrides,
  };
}

describe("SupabaseProjectRepository — generation job atomic claim & recovery (Sprint 2H Part 2B)", () => {
  describe("claimNextQueuedJob", () => {
    it("returns null when nothing is queued or recoverable", async () => {
      const { client } = createFakeGenerationJobsClient([
        makeRow({ id: "running-job", status: "running" }),
        makeRow({ id: "done-job", status: "completed" }),
      ]);
      const repo = new SupabaseProjectRepository(client);
      assert.equal(await repo.claimNextQueuedJob(), null);
    });

    it("claims the oldest of queued/recoverable jobs and marks it running", async () => {
      const { client, rows } = createFakeGenerationJobsClient([
        makeRow({ id: "newer", status: "queued", created_at: "2026-01-02T00:00:00.000Z" }),
        makeRow({ id: "older", status: "recoverable", created_at: "2026-01-01T00:00:00.000Z" }),
      ]);
      const repo = new SupabaseProjectRepository(client);

      const claimed = await repo.claimNextQueuedJob();

      assert.equal(claimed?.id, "older");
      assert.equal(claimed?.status, "running");
      assert.equal(claimed?.attempts, 1);
      const persisted = rows.find((r) => r.id === "older");
      assert.equal(persisted?.status, "running");
      assert.ok(persisted?.started_at);
      assert.ok(persisted?.heartbeat_at);
    });

    it("sequential claims never return the same job twice", async () => {
      const { client } = createFakeGenerationJobsClient([
        makeRow({ id: "job-a", created_at: "2026-01-01T00:00:00.000Z" }),
        makeRow({ id: "job-b", created_at: "2026-01-02T00:00:00.000Z" }),
      ]);
      const repo = new SupabaseProjectRepository(client);

      const first = await repo.claimNextQueuedJob();
      const second = await repo.claimNextQueuedJob();
      const third = await repo.claimNextQueuedJob();

      assert.equal(first?.id, "job-a");
      assert.equal(second?.id, "job-b");
      assert.equal(third, null);
    });

    it("update is conditioned on both id and the status just read — never an unconditional write", async () => {
      const { client, calls } = createFakeGenerationJobsClient([makeRow({ id: "job-a" })]);
      const repo = new SupabaseProjectRepository(client);
      await repo.claimNextQueuedJob();

      const updateCall = calls.find((c) => c.op === "update");
      assert.ok(updateCall, "expected an update call");
      const cols = updateCall!.eq.map((f) => f.col);
      assert.ok(cols.includes("id"));
      assert.ok(cols.includes("status"));
    });

    it("two repositories racing to claim the single queued job — exactly one wins, the other gets null", async () => {
      const { client } = createFakeGenerationJobsClient([makeRow({ id: "only-job" })]);
      const repoA = new SupabaseProjectRepository(client);
      const repoB = new SupabaseProjectRepository(client);

      const [claimedA, claimedB] = await Promise.all([
        repoA.claimNextQueuedJob(),
        repoB.claimNextQueuedJob(),
      ]);

      const winners = [claimedA, claimedB].filter((c) => c !== null);
      assert.equal(winners.length, 1, "exactly one caller should claim the job");
      assert.equal(winners[0]?.id, "only-job");
    });

    it("three repositories concurrently draining the queue — every job claimed exactly once, nothing duplicated", async () => {
      const { client } = createFakeGenerationJobsClient([
        makeRow({ id: "job-1", created_at: "2026-01-01T00:00:00.000Z" }),
        makeRow({ id: "job-2", created_at: "2026-01-02T00:00:00.000Z" }),
        makeRow({ id: "job-3", created_at: "2026-01-03T00:00:00.000Z" }),
      ]);
      const repos = [
        new SupabaseProjectRepository(client),
        new SupabaseProjectRepository(client),
        new SupabaseProjectRepository(client),
      ];

      // A single `claimNextQueuedJob()` call is one-shot: if it loses a
      // race for the oldest candidate, it returns null rather than falling
      // through to try the next-oldest job — exactly like a real
      // `UPDATE ... WHERE status = $1` either commits or matches zero
      // rows. A real worker's loop is what turns that into "keep drilling
      // until the queue is empty" (see `GenerationWorkerCapability` /
      // `GenerationSchedulerCapability`); this test reproduces that loop
      // directly against the repository, three of them racing at once.
      async function drainUntilEmpty(
        repo: InstanceType<typeof SupabaseProjectRepository>,
      ): Promise<string[]> {
        const claimed: string[] = [];
        let consecutiveMisses = 0;
        while (consecutiveMisses < 5) {
          const job = await repo.claimNextQueuedJob();
          if (job) {
            claimed.push(job.id);
            consecutiveMisses = 0;
          } else {
            consecutiveMisses += 1;
          }
        }
        return claimed;
      }

      const results = await Promise.all(repos.map(drainUntilEmpty));
      const claimedIds = results.flat();

      assert.deepEqual([...claimedIds].sort(), ["job-1", "job-2", "job-3"]);
      // No id appears twice across every racing, draining caller.
      assert.equal(new Set(claimedIds).size, claimedIds.length);
    });
  });

  describe("recoverAbandonedJobs", () => {
    const staleAfterMs = 15 * 60 * 1000;
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const justNow = new Date().toISOString();

    it("recovers a running job with a stale heartbeat", async () => {
      const { client, rows } = createFakeGenerationJobsClient([
        makeRow({ id: "stale", status: "running", started_at: longAgo, heartbeat_at: longAgo }),
      ]);
      const repo = new SupabaseProjectRepository(client);

      const recovered = await repo.recoverAbandonedJobs(staleAfterMs);

      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.status, "recoverable");
      assert.equal(rows.find((r) => r.id === "stale")?.status, "recoverable");
    });

    it("does not recover a running job with a fresh heartbeat", async () => {
      const { client } = createFakeGenerationJobsClient([
        makeRow({ id: "fresh", status: "running", started_at: justNow, heartbeat_at: justNow }),
      ]);
      const repo = new SupabaseProjectRepository(client);

      const recovered = await repo.recoverAbandonedJobs(staleAfterMs);
      assert.equal(recovered.length, 0);
    });

    it("does not recover jobs that are not 'running' (queued, completed, failed)", async () => {
      const { client } = createFakeGenerationJobsClient([
        makeRow({ id: "queued-job", status: "queued" }),
        makeRow({ id: "completed-job", status: "completed", started_at: longAgo, heartbeat_at: longAgo }),
        makeRow({ id: "failed-job", status: "failed", started_at: longAgo, heartbeat_at: longAgo }),
      ]);
      const repo = new SupabaseProjectRepository(client);

      const recovered = await repo.recoverAbandonedJobs(staleAfterMs);
      assert.equal(recovered.length, 0);
    });

    it("issues a single atomic UPDATE — never a separate prior SELECT (no read-then-blind-write gap)", async () => {
      const { client, calls } = createFakeGenerationJobsClient([
        makeRow({ id: "stale", status: "running", started_at: longAgo, heartbeat_at: longAgo }),
      ]);
      const repo = new SupabaseProjectRepository(client);
      await repo.recoverAbandonedJobs(staleAfterMs);

      assert.equal(calls.length, 1, "expected exactly one query, not select-then-update");
      assert.equal(calls[0]?.op, "update");
      assert.ok(calls[0]?.eq.some((f) => f.col === "status" && f.val === "running"));
    });

    it("never recovers a job that heartbeats between when recovery is scheduled and when it executes", async () => {
      const { client, rows } = createFakeGenerationJobsClient([
        makeRow({ id: "racy", status: "running", started_at: longAgo, heartbeat_at: longAgo }),
      ]);
      const repo = new SupabaseProjectRepository(client);

      // Simulate the owning worker's heartbeat touch landing in the same
      // window as the recovery sweep — since the fake's update predicate
      // is evaluated against *live* row state (matching real Postgres
      // semantics), a heartbeat that lands first must win.
      const recoverPromise = repo.recoverAbandonedJobs(staleAfterMs);
      const row = rows.find((r) => r.id === "racy")!;
      row.heartbeat_at = new Date().toISOString();

      const recovered = await recoverPromise;
      assert.equal(recovered.length, 0);
      assert.equal(row.status, "running");
    });
  });

  describe("touchGenerationJobHeartbeat", () => {
    it("updates only heartbeat_at for the given job id", async () => {
      const { client, rows } = createFakeGenerationJobsClient([
        makeRow({ id: "job-a", status: "running", heartbeat_at: null }),
      ]);
      const repo = new SupabaseProjectRepository(client);

      await repo.touchGenerationJobHeartbeat("job-a");

      assert.ok(rows.find((r) => r.id === "job-a")?.heartbeat_at);
    });
  });
});
