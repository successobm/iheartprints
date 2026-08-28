import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Phase 28G Defect D — source-level proof that `SeparationReviewPanel`'s
 * final-review "Prepared" image actually goes through `GarmentPreviewImage`
 * / `preview-image-commit.ts`'s atomic-commit state machine, rather than
 * binding a plain `<img src>` directly to `previewSurface` state (the
 * original defect). `preview-image-commit.test.ts` proves the state
 * machine's own behavior in isolation; this file proves the COMPONENT
 * actually uses it, and that the visible `<img>` never reads `previewSurface`
 * directly. `renderToString` cannot exercise the `useEffect`-driven preload
 * itself (this repo's test tooling has no DOM, no `Image`, no real network
 * — see the established "HONEST BOUNDARY" precedent in
 * `uploaded-artwork-separation-mount.test.tsx`), so this is a structural,
 * not a runtime, proof.
 */

const SOURCE = readFileSync(path.join(__dirname, "SeparationReviewPanel.tsx"), "utf8");

function garmentPreviewImageSource(): string {
  const start = SOURCE.indexOf("function GarmentPreviewImage(");
  const end = SOURCE.indexOf("export function SeparationReviewPanel(");
  assert.ok(start !== -1 && end !== -1 && start < end, "could not isolate GarmentPreviewImage's source");
  return SOURCE.slice(start, end);
}

describe("GarmentPreviewImage — wired to the atomic-commit state machine, not raw state", () => {
  it("uses the preview-image-commit reducer, not a hand-rolled equivalent", () => {
    assert.match(
      SOURCE,
      /import \{\s*initialPreviewCommitState,\s*requestPreviewCommit,\s*resolvePreviewCommitFailure,\s*resolvePreviewCommitSuccess,\s*shouldRequestPreviewCommit,\s*type CommittedPreview,\s*\} from "\.\/preview-image-commit";/,
    );
  });

  it("the visible <img>'s src and backgroundColor both come from `state.committed`, never directly from the `src`/`backgroundColor` props (which mirror `previewSurface` immediately on click)", () => {
    const source = garmentPreviewImageSource();
    const imgBlock = source.match(/<img\s+src=\{state\.committed\.src\}[\s\S]*?\/>/);
    assert.ok(imgBlock, "expected the rendered <img> to read its src from `state.committed`, not a raw prop");
    assert.match(imgBlock![0], /backgroundColor:\s*state\.committed\.backgroundColor/);
  });

  it("a new (src, backgroundColor) request is preloaded off-screen with a plain Image before ever touching visible state", () => {
    const source = garmentPreviewImageSource();
    assert.match(source, /new window\.Image\(\)/);
    assert.match(source, /img\.onload = \(\) => \{/);
    assert.match(source, /img\.onerror = \(\) => \{/);
  });

  it("onload commits via resolvePreviewCommitSuccess; onerror via resolvePreviewCommitFailure -- both are the ONLY way `state.committed` ever changes", () => {
    const source = garmentPreviewImageSource();
    assert.match(source, /resolvePreviewCommitSuccess\(current, generation, requested\)/);
    assert.match(source, /resolvePreviewCommitFailure\(current, generation\)/);
    // No other assignment to `committed` anywhere in this component.
    assert.doesNotMatch(source, /committed:\s*\{[^}]*src[^}]*\}/);
  });

  it("a switching request shows a loading overlay (`data-preview-updating`), not a blank or partially-updated frame", () => {
    const source = garmentPreviewImageSource();
    assert.match(source, /data-preview-updating/);
    assert.match(source, /Updating preview…/);
    assert.match(source, /state\.switching \? \(/);
  });

  it("a failed switch shows a recoverable notice (`data-preview-update-failed`) while leaving the previous frame visible", () => {
    const source = garmentPreviewImageSource();
    assert.match(source, /data-preview-update-failed/);
    // The failed-state branch renders alongside (not instead of) the
    // `state.committed`-driven <img> above it -- the previous frame stays
    // on screen underneath the notice.
    const failedIndex = source.indexOf("data-preview-update-failed");
    const imgIndex = source.indexOf("state.committed.src");
    assert.ok(imgIndex !== -1 && imgIndex < failedIndex, "the committed <img> must render before (i.e. remain present alongside) the failure notice");
  });

  it("the final-review 'Prepared' tile mounts GarmentPreviewImage, not a raw <img>, for the garment-colour preview", () => {
    const finalReviewStart = SOURCE.indexOf('data-final-review>');
    assert.ok(finalReviewStart !== -1, "could not locate the final-review block");
    const nextFewHundred = SOURCE.slice(finalReviewStart, finalReviewStart + 3000);
    assert.match(nextFewHundred, /<GarmentPreviewImage/);
    assert.match(nextFewHundred, /backgroundColor=\{previewSurface\}/);
  });
});
