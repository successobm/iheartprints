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

iHeartPrints is an independent **production-artwork** platform: the core
product is production-artwork intelligence and the production-ready artwork
it produces. The customer uses or buys the **artwork**. It does not
manufacture, print, ship, mount, or install physical products, is not a
Print'em All feature, and is not a general print-shop operating system.
Print'em All is a separate fulfillment business that consumes iHeartPrints
output; it owns no production profile.

Production scope is governed by the Constitution's profile registry (§16B).
Two profiles are constitutionally admitted: **apparel raster** (activated,
implemented, live — the DTF/DTG-oriented pipeline; deliverable: validated
transparent PNG at the selected physical print size, 300 PPI target judged
from pixel geometry) and **rigid sign raster** (admitted, NOT implemented —
deliverable when built: opaque exact-size PNG at human-confirmed ordered
dimensions under §16A's preservation and resolution rules).

**Signs guardrail.** Work on rigid sign raster is permitted ONLY inside
explicitly approved Signs phases (S1 and later, each approved by the
product owner). Outside an approved Signs phase, do not add sign behavior,
copy, or claims. This admission authorizes nothing else: no banners,
vehicle wraps, multi-panel murals, contour cutting, dimensional letters,
installation, vector ingestion (SVG/EPS/AI/PDF), general generative
redesign/outpainting/inpainting or any generative-model use against
customer artwork, CMYK/ICC workflows, imposition, sign pricing/catalogs/
fulfillment, or customer-facing sign storefront — and no embroidery,
engraving, paper, or 3D engines. Constitution §16A.3 (amendment 3.1) admits
exactly one narrow, non-generative exception — deterministic, pixel-sourced
perimeter structure reconstruction (`reconstruct_perimeter_structure`,
`src/capabilities/sign-preparation/perimeter-reconstruction.ts`), gated on
affirmative deterministic reconstructability evidence, always
operator-review-required, never inferring a manufacturing specification not
already present in the artwork or order, and never permitted to touch
protected interior content beyond uniform proportional scaling. That one
step is the entire exception; nothing else on this list is authorized by
it, and it is itself gated behind its own approved Signs phase like
everything else here. Never treat the dormant `signage`
placeholder arm in `production-requirements.ts` (36×72 in guess,
`targetPpi: null`, vector-flavored) as approved policy: the rigid-sign
profile will be built to Constitution §16A and the Phase S0 audit, not to
that placeholder. Never write copy implying sign support exists before the
sign pipeline actually produces and validates a deliverable.

**Apparel baseline protection.** The DTF Raster + Halftone V1 apparel
pipeline is proven and must not be weakened, generalized away, or regressed
by Signs work. `print_ready` is profile-scoped: an apparel print_ready
claims nothing about signs, and vice versa. Never write copy or comments
implying a file is ready for every production method, and never claim
control over downstream production variables in any profile (printer, ink,
film, powder, pretreatment, RIP, ICC profiles, press settings, garment
compatibility, substrate, mounting, installation, longevity).

Do not expand into any production category outside the §16B registry —
that needs a Constitution amendment. Embroidery digitization, screen-print
separations, sublimation-specific preparation, and vector/SVG/PDF
production remain apparel capabilities for a later, explicit production
profile — not current work. Reusable architecture may remain broader than
activated scope: dormant hooks (reserved vector/PDF roles, Print Vault and
Ownership stubs, broader validation categories) are not unfinished
requirements and must not be deleted merely to narrow the product — and
must not be treated as authorization either.

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

iHeartPrints will not knowingly create artwork that reproduces or
deliberately imitates recognizable third-party protected branding, and will
not help a customer circumvent those protections (Constitution §17.1,
`ARCHITECTURE.md` §23a, `src/capabilities/ip-safety/`). It is a product
boundary, not legal clearance: never state or imply that artwork is legally
safe, licensed, trademark-cleared, copyright-cleared, or owned; never accuse
a customer of infringement; and never state a threshold or amount of change
that would make a refused request acceptable. Themes, styles, colors, places,
generic visual concepts, and a customer's own branding remain allowed.
Ownership classification is separate architecture and is not rights
verification; preparing uploaded artwork is a technical operation, not an
ownership determination; provider safety systems remain independent and must
not be weakened or bypassed.

When another instruction, roadmap item, or implementation preference conflicts with the Constitution, the Constitution takes precedence unless it has been formally amended.
