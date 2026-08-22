import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// STATIC, top-level, and deliberately so. This import is the hazard under
// test: it evaluates `local-store.ts` while cwd is still the repo root, which
// is exactly the position a suite importing `@/capabilities/composition` ends
// up in. If the module ever goes back to resolving its path at import time,
// this file is the one that notices.
import { LocalProjectRepository } from "./local-store";

import { removeTempDir } from "@/test-support/remove-temp-dir";

/**
 * REGISTERED TESTS MUST NEVER WRITE TO THE REAL DEVELOPMENT RUNTIME STORE.
 *
 * The defect this locks closed: `local-store.ts` resolved its on-disk path
 * into module-level constants at import time. A suite that reached the module
 * through its STATIC import graph bound those constants to the developer's
 * own `.data/sprint1-store.json` before its `before()` hook could `chdir`
 * into a temp workspace — so its writes silently landed in real local data.
 * `production-treatment-authorization.test.ts` accumulated 36 rows there.
 *
 * The fix is to resolve the path per call. These tests assert the OUTCOME of
 * that (writes follow cwd, the repo-root store is untouched) rather than the
 * mechanism, so a different correct implementation still passes.
 */
describe("Local store isolation — registered tests never write real .data", () => {
  /** The repo root, captured before any test changes cwd. */
  let repoRoot = "";
  /** The developer's real store, which must be byte-identical afterwards. */
  let realStorePath = "";
  let realStoreExisted = false;
  let realStoreHashBefore: string | null = null;
  let realStoreMtimeBefore: number | null = null;

  const tempDirs: string[] = [];

  function hashFile(file: string): string {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  }

  before(() => {
    repoRoot = process.cwd();
    realStorePath = path.join(repoRoot, ".data", "sprint1-store.json");
    realStoreExisted = existsSync(realStorePath);
    if (realStoreExisted) {
      realStoreHashBefore = hashFile(realStorePath);
      realStoreMtimeBefore = statSync(realStorePath).mtimeMs;
    }
  });

  after(async () => {
    // Restore cwd first so the temp dirs are removable on Windows.
    process.chdir(repoRoot);

    const { drainLocalStoreMutexForTests } = await import("./local-store");
    await drainLocalStoreMutexForTests();

    for (const dir of tempDirs) await removeTempDir(dir);

    // THE ASSERTION THIS FILE EXISTS FOR. Everything above wrote projects,
    // briefs and conversations through the real repository; none of it may
    // have reached the developer's store.
    if (realStoreExisted) {
      assert.equal(
        hashFile(realStorePath),
        realStoreHashBefore,
        "registered tests must not modify the real .data/sprint1-store.json",
      );
      assert.equal(
        statSync(realStorePath).mtimeMs,
        realStoreMtimeBefore,
        "the real store must not even be rewritten with identical bytes",
      );
    } else {
      assert.equal(
        existsSync(realStorePath),
        false,
        "registered tests must not CREATE a real .data/sprint1-store.json",
      );
    }
  });

  /** A fresh isolated workspace, entered the way every suite enters one. */
  function enterTempWorkspace(label: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), `iheartprints-store-iso-${label}-`));
    tempDirs.push(dir);
    process.chdir(dir);
    return dir;
  }

  it("writes into the cwd it was given, not the cwd it was imported under", async () => {
    const dir = enterTempWorkspace("basic");

    const repo = new LocalProjectRepository();
    const { project } = await repo.createProject();

    const isolatedStore = path.join(dir, ".data", "sprint1-store.json");
    assert.ok(
      existsSync(isolatedStore),
      "the project must have been persisted inside the temp workspace",
    );

    const db = JSON.parse(readFileSync(isolatedStore, "utf8")) as {
      projects: Array<{ id: string }>;
    };
    assert.equal(db.projects.length, 1);
    assert.equal(db.projects[0]!.id, project.id);
  });

  it("keeps successive workspaces from seeing each other's data", async () => {
    const first = enterTempWorkspace("repeat-a");
    const firstRepo = new LocalProjectRepository();
    await firstRepo.createProject();
    await firstRepo.createProject();

    const second = enterTempWorkspace("repeat-b");
    const secondRepo = new LocalProjectRepository();
    const { project: only } = await secondRepo.createProject();

    const read = (dir: string) =>
      JSON.parse(
        readFileSync(path.join(dir, ".data", "sprint1-store.json"), "utf8"),
      ) as { projects: Array<{ id: string }> };

    assert.equal(read(first).projects.length, 2);

    const secondProjects = read(second).projects;
    assert.equal(
      secondProjects.length,
      1,
      "a new workspace must start from an empty store, not inherit the last one",
    );
    assert.equal(secondProjects[0]!.id, only.id);
  });

  it("drains outstanding writes before teardown rather than racing them", async () => {
    const dir = enterTempWorkspace("drain");
    const repo = new LocalProjectRepository();

    // Fire concurrent writes and drain, which is what `cleanupTempWorkspace`
    // does before it removes the directory. Every write must be on disk when
    // the drain resolves, or teardown would delete the cwd mid-write.
    const created = await Promise.all(
      Array.from({ length: 8 }, () => repo.createProject()),
    );

    const { drainLocalStoreMutexForTests } = await import("./local-store");
    await drainLocalStoreMutexForTests();

    const db = JSON.parse(
      readFileSync(path.join(dir, ".data", "sprint1-store.json"), "utf8"),
    ) as { projects: Array<{ id: string }> };

    assert.equal(
      db.projects.length,
      created.length,
      "every queued write must be flushed before the drain resolves",
    );
    for (const { project } of created) {
      assert.ok(
        db.projects.some((row) => row.id === project.id),
        `project ${project.id} must be durable after the drain`,
      );
    }
  });
});
