<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# iHeartPrints product governance

`IHEARTPRINTS_CONSTITUTION.md` is the highest-authority product document for this repository.

Before proposing significant product, UX, domain-model, or architecture changes:

1. Read `IHEARTPRINTS_CONSTITUTION.md`.
2. Evaluate the proposal against the Constitutional Test in that document.
3. Identify potential product drift toward non-goals such as general-purpose image generation, prompt-engineering UX, or exposing technical generation settings.
4. State clearly when a user request conflicts with the Constitution.
5. Preserve the Design Brief as the authoritative domain object. Images and chat messages are inputs or outputs; they do not replace the brief.
6. Prefer conversation and Design Interview flows over complicated forms.
7. Hide image-model, DPI, format, resolution, and other production settings from ordinary customers unless a meaningful customer decision requires a plain-language explanation.
8. Do not describe generated concepts as print-ready without validation and appropriate approval.

When another instruction, roadmap item, or implementation preference conflicts with the Constitution, the Constitution takes precedence unless it has been formally amended.
