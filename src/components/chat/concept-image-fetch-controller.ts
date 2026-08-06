/**
 * Sprint 2K Phase 2 — Workstream D root cause.
 *
 * `ConceptCards` mints a per-concept signed image URL by calling the image
 * endpoint once per concept, then never again while the URL stays fresh.
 * The dedup guard used a `Set` ref (`pending`) plus a `cancelled` closure
 * flag, but the effect's cleanup only ever flipped `cancelled` — it never
 * removed the ids *that same effect run* had added to `pending`.
 *
 * That is invisible with a single mount, but React's Strict Mode (the app
 * router default since Next.js 13.5, see next.config.ts / AGENTS.md) always
 * mounts a component twice in development: mount → cleanup → mount again.
 * Sequence with the old code, for one concept id "c1":
 *
 *   1. mount #1 effect runs: pending.add("c1"); starts fetch #1.
 *   2. React tears down mount #1 immediately: cleanup sets cancelled #1 =
 *      true, but never touches `pending` — "c1" is still marked pending.
 *   3. mount #2 (the one that actually stays) runs: sees pending.has("c1")
 *      already true, so it starts NO fetch of its own.
 *   4. fetch #1 eventually resolves. It deletes "c1" from `pending` (fine),
 *      then checks `cancelled` from *its own* closure — true — and returns
 *      without ever calling `setImages`.
 *
 * Net result: no fetch's result is ever applied to state. `images[id]`
 * stays `undefined` forever, so the card is stuck showing "Loading…"
 * indefinitely even though the backend, worker, and image endpoint all
 * completed successfully — exactly the reported symptom. Production builds
 * (single mount, no Strict Mode double-invoke) don't reproduce it, which is
 * why it only showed up testing against the real generation pipeline in
 * development.
 *
 * The fix: cleanup removes only the ids *that run's* effect started, so the
 * next (kept) mount is free to start its own fetch instead of finding a
 * permanently "pending" id nobody will ever resolve. Extracted out of the
 * component (rather than inlined in the `useEffect`) so this exact
 * mount/cleanup/mount sequence can be unit tested without a DOM/React
 * renderer — this repo's test tooling is `node:test` + `renderToString`
 * (SSR only; effects never run there).
 */

export type ConceptImageState =
  | { status: "ready"; url: string }
  | { status: "unavailable" };

export interface FetchableConcept {
  id: string;
  hasImage: boolean;
}

export interface ConceptImageFetchController {
  /**
   * Call once per effect invocation (i.e. once per mount, and again on
   * every dependency-array change). Returns the cleanup function for that
   * same invocation — return it directly from the `useEffect` callback.
   */
  start(
    concepts: readonly FetchableConcept[],
    getImage: (id: string) => ConceptImageState | undefined,
    setImage: (id: string, state: ConceptImageState) => void,
    fetchUrl: (id: string) => Promise<string | null>,
  ): () => void;
}

/**
 * One controller instance per `ConceptCards` mount lifetime (hold it in a
 * `useRef`, same as the old `pendingRef`) — the in-flight/pending id set
 * must survive across the mount → cleanup → mount Strict Mode sequence,
 * which is exactly why it can't just be local state inside the effect.
 */
export function createConceptImageFetchController(): ConceptImageFetchController {
  const pending = new Set<string>();

  return {
    start(concepts, getImage, setImage, fetchUrl) {
      let cancelled = false;
      const startedByThisRun: string[] = [];

      for (const concept of concepts) {
        if (!concept.hasImage) continue;
        if (getImage(concept.id) || pending.has(concept.id)) continue;

        pending.add(concept.id);
        startedByThisRun.push(concept.id);

        void fetchUrl(concept.id).then((url) => {
          pending.delete(concept.id);
          if (cancelled) return;
          setImage(
            concept.id,
            url ? { status: "ready", url } : { status: "unavailable" },
          );
        });
      }

      return () => {
        cancelled = true;
        // Only clear ids *this invocation* added — a still-pending id
        // started by a still-live invocation must not be freed early.
        for (const id of startedByThisRun) {
          pending.delete(id);
        }
      };
    },
  };
}
