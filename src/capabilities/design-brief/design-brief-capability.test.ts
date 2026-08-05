import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { removeTempDir } from "@/test-support/remove-temp-dir";

describe("DesignBriefCapability.approveWorkingBrief", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-brief-"));
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(previousCwd);
    await removeTempDir(tempDir);
  });

  it("creates version 1 on first approval and reuses it for an unchanged brief", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { createDesignBriefCapability } = await import(
      "./design-brief-capability"
    );

    const repo = new LocalProjectRepository();
    const designBrief = createDesignBriefCapability(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
    });

    const first = await designBrief.approveWorkingBrief(created.project.id);
    assert.equal(first.versionNumber, 1);
    assert.equal(first.status, "approved");

    // No brief change since the last approval — must not create version 2.
    const second = await designBrief.approveWorkingBrief(created.project.id);
    assert.equal(second.id, first.id);
    assert.equal(second.versionNumber, 1);

    const latest = await designBrief.getLatestApprovedVersion(
      created.project.id,
    );
    assert.equal(latest?.id, first.id);
  });

  it("creates a new version when the working brief changed since the last approval", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { createDesignBriefCapability } = await import(
      "./design-brief-capability"
    );

    const repo = new LocalProjectRepository();
    const designBrief = createDesignBriefCapability(repo);

    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
    });

    const first = await designBrief.approveWorkingBrief(created.project.id);
    assert.equal(first.versionNumber, 1);

    await repo.updateBrief(created.project.id, {
      shirtColor: "Forest green",
    });

    const second = await designBrief.approveWorkingBrief(created.project.id);
    assert.equal(second.versionNumber, 2);
    assert.notEqual(second.id, first.id);
  });

  it("resolves a duplicate-version race by returning the winning row instead of throwing", async () => {
    const { LocalProjectRepository } = await import("@/lib/db/local-store");
    const { UniqueConstraintViolationError } = await import(
      "@/lib/db/repository"
    );
    const { createDesignBriefCapability } = await import(
      "./design-brief-capability"
    );

    const repo = new LocalProjectRepository();
    const created = await repo.createProject();
    await repo.updateBrief(created.project.id, {
      productSummary: "Camp shirts",
    });

    // Simulate a concurrent approval having already won the race for
    // version 1 by wrapping the repo's approveDesignBrief.
    const winningVersion = await repo.approveDesignBrief(created.project.id, {
      briefId: created.brief.id,
      versionNumber: 1,
      content: {
        productSummary: "Camp shirts",
        designDescription: null,
        exactText: null,
        shirtColor: null,
        printPlacement: "full_front",
        preferredColors: [],
        designStyle: null,
        additionalInstructions: null,
        audience: null,
        purpose: null,
        exclusions: null,
        deferredSections: [],
      },
    });

    let attempted = false;
    const racingRepo: typeof repo = Object.create(repo);
    racingRepo.approveDesignBrief = async () => {
      attempted = true;
      throw new UniqueConstraintViolationError(
        "design_brief_versions_project_id_version_number",
      );
    };
    racingRepo.getLatestDesignBriefVersion = (projectId: string) =>
      repo.getLatestDesignBriefVersion(projectId);

    const designBrief = createDesignBriefCapability(racingRepo);

    // Force a mismatch so approveWorkingBrief attempts a fresh insert rather
    // than short-circuiting on content equality.
    await repo.updateBrief(created.project.id, { shirtColor: "Navy" });

    const result = await designBrief.approveWorkingBrief(created.project.id);
    assert.ok(attempted, "expected the racing insert to be attempted");
    assert.equal(result.id, winningVersion.id);
  });
});
