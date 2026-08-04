import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHAT_PROJECT_STORAGE_KEY,
  planSessionBootstrap,
} from "./chat-session";

describe("planSessionBootstrap", () => {
  it("restores persisted Sprint 1 project ids instead of creating a new chat", () => {
    const plan = planSessionBootstrap("11111111-1111-1111-1111-111111111111");
    assert.deepEqual(plan, {
      action: "restore",
      projectId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("does not treat empty/missing storage as a restore (avoids incorrect reset loops)", () => {
    assert.deepEqual(planSessionBootstrap(null), { action: "create" });
    assert.deepEqual(planSessionBootstrap(undefined), { action: "create" });
    assert.deepEqual(planSessionBootstrap(""), { action: "create" });
    assert.deepEqual(planSessionBootstrap("   "), { action: "create" });
  });

  it("keeps the stable localStorage key used by ChatApp", () => {
    assert.equal(CHAT_PROJECT_STORAGE_KEY, "iheartprints.sprint1.projectId");
  });
});
