<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# iHeartPrints product governance

`IHEARTPRINTS_CONSTITUTION.md` is the highest-authority product document for this repository.

`ARCHITECTURE.md` is the second-highest architectural reference. It documents
current domain boundaries, capability responsibilities, dependency direction,
persistence, generation runtime, and security architecture.

iHeartPrints is an independent **apparel-design** product. The customer uses
or buys the **artwork**. It does not sell physical garments, is not a
Print'em All feature, and is not a general print-shop operating system.

Product scope is not current production capability. The product serves the
apparel-design market; V1 implements one production profile inside it —
raster garment decoration, focused initially on DTF and DTG workflows.

The current V1 deliverable is a validated transparent PNG at the selected
physical print dimensions, targeted at 300 PPI. `print_ready` is scoped to
that supported raster profile; never write copy or comments implying a file
is ready for every apparel-decoration method, and never claim control over
downstream production variables (printer, ink, film, powder, pretreatment,
RIP, ICC profiles, press settings, garment compatibility).

Do not expand into signs, banners, large-format, promotional products,
general commercial printing, or physical-product commerce — those are
outside the product. Do not implement embroidery digitization, screen-print
separations, sublimation-specific preparation, or vector/SVG/PDF production
either: they are apparel capabilities for a later, explicit production
profile, not V1 work. Either kind of expansion needs an explicit
Constitution amendment.

Reusable architecture may remain broader than active product scope. Dormant
hooks (reserved vector/PDF roles, Print Vault and Ownership stubs, broader
validation categories) are not unfinished V1 requirements and must not be
deleted merely to narrow the product.

Before proposing significant product, UX, domain-model, or architecture changes:

1. Read `IHEARTPRINTS_CONSTITUTION.md`.
2. Read `ARCHITECTURE.md`.
3. Evaluate the proposal against the Constitutional Test in the Constitution.
4. Identify potential product drift toward non-goals such as general-purpose image generation, prompt-engineering UX, exposing technical generation settings, physical-product retail, or general print categories.
5. State clearly when a user request conflicts with the Constitution or the documented architecture.
6. Preserve the Design Brief as the authoritative domain object on the Create New path. Images and chat messages are inputs or outputs; they do not replace the brief. On the Existing Artwork path, uploaded pixels are the visual specification.
7. Prefer conversation and Design Interview flows over complicated forms.
8. Hide image-model, provider, format, and generation settings from ordinary customers. Apparel placement and physical print size are meaningful customer decisions. The 300 PPI density target is a guarantee judged from pixel geometry, not a customer-operated control and not a PNG-metadata promise.
9. Do not describe generated concepts as print-ready without authoritative production validation and appropriate approval.
10. Preserve capability dependency direction from `ARCHITECTURE.md` / `src/capabilities/shared/capability-boundaries.ts`.
11. When architectural boundaries change, update `ARCHITECTURE.md` in the same change.

When another instruction, roadmap item, or implementation preference conflicts with the Constitution, the Constitution takes precedence unless it has been formally amended.
