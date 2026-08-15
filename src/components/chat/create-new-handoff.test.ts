import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handoffToCreateNewInterview } from "./create-new-handoff";

describe("Create New Artwork handoff", () => {
  it("dismisses the choice and focuses the existing project's enabled composer", () => {
    const project = {
      id: "existing-project",
      phase: "interviewing",
      acquisitionState: "open",
    } as const;
    let workflowChoice = "undecided";
    let scheduled: FrameRequestCallback | null = null;
    let focusOptions: FocusOptions | undefined;
    let scrollOptions: ScrollIntoViewOptions | undefined;
    const projectPosts = 0;

    handoffToCreateNewInterview({
      selectCreateNew: () => {
        workflowChoice = "create_new";
      },
      getComposer: () => ({
        disabled: false,
        focus(options) {
          focusOptions = options;
        },
        scrollIntoView(options) {
          scrollOptions = options;
        },
      }),
      schedule: (callback) => {
        scheduled = callback;
        return 1;
      },
    });

    assert.equal(workflowChoice, "create_new");
    assert.equal(project.id, "existing-project");
    assert.equal(project.phase, "interviewing");
    assert.equal(project.acquisitionState, "open");
    assert.equal(projectPosts, 0);

    assert.ok(scheduled);
    (scheduled as FrameRequestCallback)(0);
    assert.deepEqual(scrollOptions, { behavior: "smooth", block: "center" });
    assert.deepEqual(focusOptions, { preventScroll: true });
  });

  it("does not affect the sibling Existing Artwork workflow", () => {
    let existingArtworkChoice = "undecided";
    const chooseExistingArtwork = () => {
      existingArtworkChoice = "upload_existing";
    };

    chooseExistingArtwork();

    assert.equal(existingArtworkChoice, "upload_existing");
  });
});
