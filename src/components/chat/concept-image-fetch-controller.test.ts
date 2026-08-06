import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createConceptImageFetchController,
  type ConceptImageState,
} from "./concept-image-fetch-controller";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createConceptImageFetchController", () => {
  it("resolves a single mount's fetch into image state (baseline behavior)", async () => {
    const controller = createConceptImageFetchController();
    const images: Record<string, ConceptImageState> = {};

    const cleanup = controller.start(
      [{ id: "c1", hasImage: true }],
      (id) => images[id],
      (id, state) => {
        images[id] = state;
      },
      async () => "https://example.test/signed-url",
    );

    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(images.c1, { status: "ready", url: "https://example.test/signed-url" });
    cleanup();
  });

  it(
    "survives a React Strict Mode mount → cleanup → mount double-invoke " +
      "without getting stuck (Workstream D root cause)",
    async () => {
      const controller = createConceptImageFetchController();
      const images: Record<string, ConceptImageState> = {};
      const getImage = (id: string) => images[id];
      const setImage = (id: string, state: ConceptImageState) => {
        images[id] = state;
      };

      const first = deferred<string | null>();
      let fetchCallCount = 0;
      const fetchUrl = (): Promise<string | null> => {
        fetchCallCount++;
        // First call (mount #1) never resolves until we say so below;
        // every subsequent call resolves immediately with a URL.
        return fetchCallCount === 1
          ? first.promise
          : Promise.resolve("https://example.test/signed-url-2");
      };

      // Mount #1 (Strict Mode's throwaway mount).
      const cleanup1 = controller.start(
        [{ id: "c1", hasImage: true }],
        getImage,
        setImage,
        fetchUrl,
      );
      // React tears mount #1 down immediately, before its fetch resolves.
      cleanup1();

      // Mount #2 (the one that actually stays mounted).
      const cleanup2 = controller.start(
        [{ id: "c1", hasImage: true }],
        getImage,
        setImage,
        fetchUrl,
      );

      // Let mount #2's fetch resolve.
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(
        fetchCallCount,
        2,
        "mount #2 must start its own fetch instead of finding the id permanently 'pending'",
      );
      assert.deepEqual(
        images.c1,
        { status: "ready", url: "https://example.test/signed-url-2" },
        "the card must reach the ready state instead of staying stuck in Loading forever",
      );

      // Mount #1's stale fetch resolving late must not overwrite the
      // now-current state with a discarded result.
      first.resolve("https://example.test/stale-url");
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(images.c1, {
        status: "ready",
        url: "https://example.test/signed-url-2",
      });

      cleanup2();
    },
  );

  it("does not start a duplicate fetch for a concept still pending from a live (not cleaned-up) run", async () => {
    const controller = createConceptImageFetchController();
    const images: Record<string, ConceptImageState> = {};
    let fetchCallCount = 0;
    const pending = deferred<string | null>();

    const fetchUrl = () => {
      fetchCallCount++;
      return pending.promise;
    };

    controller.start(
      [{ id: "c1", hasImage: true }],
      (id) => images[id],
      (id, state) => {
        images[id] = state;
      },
      fetchUrl,
    );
    // A second start() call (e.g. a re-render with the same concept list)
    // before the first fetch resolves must not start a second request.
    controller.start(
      [{ id: "c1", hasImage: true }],
      (id) => images[id],
      (id, state) => {
        images[id] = state;
      },
      fetchUrl,
    );

    assert.equal(fetchCallCount, 1);
    pending.resolve("https://example.test/url");
  });

  it("never starts a fetch for a concept without a generated image", async () => {
    const controller = createConceptImageFetchController();
    let fetchCallCount = 0;

    controller.start(
      [{ id: "c1", hasImage: false }],
      () => undefined,
      () => {},
      () => {
        fetchCallCount++;
        return Promise.resolve(null);
      },
    );

    assert.equal(fetchCallCount, 0);
  });
});
