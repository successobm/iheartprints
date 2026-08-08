import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("GET /api/dev/local-generation-trigger", () => {
  it("returns 404 in automated tests", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/dev/local-generation-trigger"),
    );
    assert.equal(response.status, 404);
  });
});
