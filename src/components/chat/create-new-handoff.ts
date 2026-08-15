export interface CreateNewComposerTarget {
  readonly disabled: boolean;
  focus(options?: FocusOptions): void;
  scrollIntoView(options?: ScrollIntoViewOptions): void;
}

interface CreateNewHandoffInput {
  selectCreateNew: () => void;
  getComposer: () => CreateNewComposerTarget | null;
  schedule?: (callback: FrameRequestCallback) => number;
}

/**
 * Completes the purely client-side handoff from the workflow choice to the
 * already-created project's design interview. Scheduling one frame lets
 * React remove the choice card before the composer is gently revealed and
 * focused; it does not create, reload, or mutate the project.
 */
export function handoffToCreateNewInterview({
  selectCreateNew,
  getComposer,
  schedule = requestAnimationFrame,
}: CreateNewHandoffInput): void {
  selectCreateNew();
  schedule(() => {
    const composer = getComposer();
    if (!composer || composer.disabled) return;
    composer.scrollIntoView({ behavior: "smooth", block: "center" });
    composer.focus({ preventScroll: true });
  });
}
