# iHeartPrints Constitution

**Version 2.1**

## 1. Purpose of the Constitution

This Constitution defines the enduring product identity of iHeartPrints.

It exists to keep the product coherent as features evolve, teams change, and technology advances. It describes what iHeartPrints is for, how it should behave, what it must never become, and how future decisions should be judged.

This document is intentionally timeless. It does not prescribe a specific vendor, host, framework, sprint plan, or temporary roadmap. Those belong in separate operational documents.

## 2. Why iHeartPrints Exists

Creating apparel artwork that is actually ready to print is hard for people who are not professional designers.

Customers know what they want on a shirt, hoodie, or other garment—a team mark, an event graphic, a personal design—but they rarely know how to turn that intent into a production-ready file. Traditional design tools demand expertise. Generic AI image tools demand prompt engineering and still leave customers responsible for printability, dimensions, backgrounds, contrast, and production constraints.

iHeartPrints exists to close that gap for **apparel design**.

It helps people move from an idea or an existing file to professional, print-ready apparel artwork through guided conversation, structured design understanding, and production-aware preparation.

## 3. Vision

Anyone with an idea for apparel artwork should be able to create or prepare something a professional apparel decorator would be proud to print—without learning design software, print engineering, or image-generation mechanics.

## 4. Mission

iHeartPrints is an independent conversational apparel-design product. It helps people create or prepare artwork and produce a validated transparent PNG for the apparel raster decoration workflows iHeartPrints currently supports.

Unlike traditional AI image generators that begin with a prompt, iHeartPrints begins with a Design Interview when the customer is creating new artwork.

The goal is not merely to generate images.

The goal is to produce apparel artwork that is ready to print.

## 5. Product Identity

iHeartPrints is an independent product. Print'em All is the parent company and may separately use, embed, or extend iHeartPrints technology. That relationship must not define iHeartPrints product architecture, roadmap, or customer experience.

The primary product is **design**. The customer uses or buys the **artwork**. iHeartPrints does not sell the physical garment.

The core journey is:

Create or Upload → Refine → Approve → Select apparel placement and production dimensions → Make Print-Ready → Validate → Download

Two creation paths are first-class:

- **Create New** — conversation, Design Brief, concepts, revisions, approval, then print-ready PNG.
- **Existing Artwork** — upload, preparation, transparency as needed, size, then print-ready PNG.

A future “Need a printer?” directory or referral experience is allowed. It is not part of the current product and does not make iHeartPrints a retailer.

## 6. Product Philosophy

iHeartPrints should feel like working with an experienced apparel designer.

Customers should describe what they want the artwork to communicate, not how to operate an image model. They should not need to understand image models, provider names, file-format knobs, or generation settings.

They **do** make meaningful apparel decisions: garment, garment color, print placement, and physical print size. When those must be explained, explain them in plain language. Technical production density is a guarantee the system keeps (300 pixels per inch of the selected physical size), not a setting the customer operates.

The product succeeds when the customer focuses on meaning, audience, style, wording, and purpose—while the system quietly handles the technical work required to make the artwork printable on apparel.

Conversation is the product. Artwork is the outcome.

## 7. Core Principles

### 7.1 Print Ready First

Customers are not buying AI. They are buying apparel artwork that can be printed.

Every major product decision should improve the path from intent to a validated production PNG for the supported apparel raster profile (§16). Novelty, spectacle, or model capability that does not improve that path is secondary.

### 7.2 Conversation Is the Product

The primary experience is conversation with a Design Assistant that behaves like an experienced apparel designer.

The product should not feel like operating design software or prompting an image model. It should feel like being interviewed, guided, and advised by someone who understands both design and apparel production.

### 7.3 Conversation Over Forms

Prefer natural conversation and one question at a time over complicated forms.

Forms may support the experience when they reduce friction—especially for upload details, placement, and print size—but they must not replace the Design Interview as the primary way customers creating new artwork express intent.

### 7.4 Understand Before Generating

Never generate artwork from incomplete information.

On the Create New path, the Design Interview must gather and confirm the Design Brief before concept generation. Speed that skips understanding creates waste, revisions, and unprintable results.

On the Existing Artwork path, the uploaded pixels are the visual specification. The product must still confirm the apparel production facts it needs (garment, garment color, placement, and print size) before claiming print readiness.

### 7.5 The Design Brief Is the Source of Truth for Created Designs

On the Create New path, every concept, revision, approved file, and production file must originate from a versioned Design Brief.

Images are outputs of the Design Brief. They never replace it as the authoritative record of customer intent.

When conversation and artwork appear to disagree, the confirmed Design Brief governs until the customer intentionally updates and confirms a new version.

On the Existing Artwork path, the customer’s uploaded pixels are the visual specification. The Design Brief records production facts for that artwork; it must not invent a competing written description of pixels the customer already supplied.

### 7.6 Hide Technical Complexity

The system determines technical settings automatically.

Users should not have to select image models, file formats, export mechanics, or other production internals. Apparel placement and physical print size are customer decisions, not hidden technical settings. Production density (300 PPI) is a stated guarantee at the chosen size, not a customer-operated control.

When a technical choice must be explained, explain it in plain language and only when it helps the customer make a meaningful decision.

### 7.7 Print Before AI

The product should emphasize the customer’s desired apparel outcome, not artificial intelligence.

AI is a means. Print-ready apparel artwork is the promise.

### 7.8 Product Intelligence

The Design Assistant should not blindly follow poor design instructions.

It should identify issues such as weak contrast, unreadable wording, unsuitable colors, excessive detail for a small placement, and other apparel production risks. It should recommend improvements in plain language and help customers make better decisions without shaming them or exposing technical jargon.

### 7.9 Production Awareness

For current iHeartPrints, production awareness centers on apparel:

- garment
- garment color
- print placement
- physical print size
- transparent raster production
- whether the artwork is actually ready to print

The current production focus is raster garment decoration—initially DTF (direct-to-film) and DTG (direct-to-garment) workflows—because those workflows consume exactly what the system produces: a transparent RGB raster file at a known physical size.

The customer should not need to understand decoration-method internals, and decoration-method names are not customer-facing vocabulary. V1 does not collect a decoration method as an output contract, and it does not produce embroidery digitization, screen-print separations, or vector production as deliverables.

iHeartPrints is responsible for the artwork file. It is not responsible for, and must not claim authority over, downstream production variables it does not operate: printer hardware, ink systems, film, powder, pretreatment, RIP configuration, printer-specific color management, ICC profiles, transfer temperature/time/pressure, garment compatibility, or a specific shop's production settings.

### 7.10 Concepts Must Respect the Brief

Generated concepts must not randomly change the approved style.

Concept variation should primarily come from layout, composition, typography, graphic arrangement, and visual hierarchy. All concepts must remain faithful to the approved Design Brief.

### 7.11 Version Everything

Design Briefs, generated concepts, revisions, approved artwork, prepared uploads, and production files must be versioned.

Prior versions should remain available and must not be destructively overwritten. Continuity and recoverability are part of professional trust.

### 7.12 Print Quality Is Mandatory

Artwork may only be treated as print-ready after authoritative production validation of the production asset, plus the customer’s explicit approval of the design (Create New) or prepared artwork (Existing Artwork).

No concept should be described as print-ready merely because an image model generated it. No uploaded file should be described as print-ready merely because it was uploaded or had its background removed.

### 7.13 Product Scope Is Not Current Production Capability

Two things must never be confused:

- **Product scope** — the market iHeartPrints serves: apparel design and artwork preparation.
- **Production capability** — the apparel production profiles the system can actually produce and validate today.

The current production capability is narrower than the product scope, and deliberately so. A present production limitation is a capability statement, not a permanent product boundary. New apparel production profiles may be added intentionally as decoration technology and customer demand evolve.

The reverse also holds: capability may not be assumed from scope. Nothing may be described as supported, ready, or validated for an apparel production profile the system does not actually produce and validate.

Non-apparel print categories are a different matter entirely. They are excluded by product scope (§20), not by current capability, and adding capability would not bring them in.

## 8. The Role of the Design Assistant

The Design Assistant is the customer’s guide through iHeartPrints.

It should behave as an experienced apparel designer whose responsibilities include:

- asking the right questions
- identifying missing information
- translating customer ideas into structured Design Briefs
- recommending improvements
- preventing avoidable production problems
- explaining choices in plain language
- maintaining continuity through revisions
- preserving customer intent
- preparing artwork for apparel production
- adapting to the customer’s knowledge level

The Design Assistant must never require customers to learn prompt engineering. It should meet customers where they are, elevate the quality of the outcome, and remain accountable to the Design Brief on the Create New path and to the customer’s own artwork on the Existing Artwork path.

## 9. Conversation as the Primary Product Experience

The home of iHeartPrints is conversation.

The interface may present summaries, concept cards, previews, approvals, size choices, and downloads, but those are supporting surfaces. The product’s center of gravity is a guided dialogue that gathers intent, confirms understanding, proposes directions, and carries revisions forward.

Conversation should be:

- one primary question at a time when discovery is underway
- adaptive based on prior answers
- respectful of the customer’s time
- clear about what happens next
- continuous across interview, concepts, revisions, approval, and print-ready preparation

## 10. The Design Interview

The Design Interview is how Create New earns the right to generate artwork. It gathers information naturally, including:

- what garment the artwork is for
- who it is for
- purpose or occasion
- desired style
- graphics or imagery
- colors
- required wording
- garment color
- print placement
- references
- exclusions
- anything else that matters to the design

The interview should adapt based on prior answers and should not ask unnecessary questions. It should clarify ambiguity, surface risks early, and help the customer make better choices.

Physical print size is a production decision presented when the customer is ready to make print-ready artwork, not a reason to turn the interview into a technical questionnaire.

At the end of the interview, the system should present a clear Design Summary and require customer confirmation before concept generation.

## 11. The Design Brief as the Authoritative Source of Truth

On the Create New path, the Design Brief is the structured, versioned record of design intent and apparel production requirements.

It is the authoritative domain object for created designs. Concepts, revisions, approvals, production files, and future variations must be traceable to a Design Brief version.

Chat messages may inform the brief. Images may illustrate the brief. Neither replaces the brief.

## 12. Separation of Design Intent and Production Requirements

iHeartPrints must distinguish two layers that work together.

### Design Intent

What the customer wants the artwork to communicate or look like.

Examples:

- audience
- mood
- style
- imagery
- wording
- colors
- visual references

### Production Requirements

What is necessary to produce the apparel artwork successfully.

Examples:

- garment
- garment color
- print placement
- physical print dimensions
- transparency / background requirements
- sufficient resolution for the selected size

The system should connect these layers without exposing unnecessary complexity. Customers should experience one coherent product; the product should maintain the structured separation behind the scenes.

Decoration method as a customer-selected output contract, RIP presets, CMYK conversion, and vector/separation pipelines are not iHeartPrints V1 production requirements. The V1 profile targets DTF/DTG raster decoration; the customer chooses the garment, placement, and physical size, not the decoration method.

## 13. Product and Print Intelligence

iHeartPrints must understand that good apparel artwork is not only visually appealing—it must survive the realities of garment printing.

The Design Assistant should reason about garment, garment color, placement, physical size, color relationships, readability, detail density, and other constraints that affect whether artwork can be printed well on apparel.

Guidance should be practical and plainspoken. The product should prevent avoidable failure modes before they become expensive revisions or unusable files.

## 14. Concept-Generation Rules

On the Create New path, concept generation begins only after the Design Brief has been confirmed.

Concepts must:

- remain faithful to the confirmed Design Brief
- preserve required wording as structured data, not as disposable decoration
- vary primarily through layout, composition, typography, graphic arrangement, and visual hierarchy
- avoid random style drift
- be presented as options for human review, not as guaranteed print-ready finals

The purpose of concepts is to explore strong interpretations of the brief, not to invent a different brief.

## 15. Revision and Versioning Principles

Revisions continue the same design relationship. They do not restart from zero unless the customer intentionally begins a new design.

Every meaningful change to the Design Brief, every generated concept, every revision, every approval, and every production file should create or reference a durable version.

Prior versions remain available. The system must not silently overwrite history. Customers should be able to return to earlier decisions with confidence.

## 16. V1 Production Contract

### 16.1 The supported production profile

V1 supports one production profile: **raster garment decoration**, targeted initially at **DTF (direct-to-film)** and **DTG (direct-to-garment)** workflows. Those workflows consume exactly what iHeartPrints produces—a transparent RGB raster file at a known physical size—which is why they are the launch focus.

This is the current capability, not the permanent limit of the product (§7.13).

### 16.2 The deliverable

The current iHeartPrints production deliverable is the **iHeartPrints Production PNG** for the supported apparel raster profile.

It is:

- PNG
- transparent where required by the apparel raster profile
- RGB
- sized to the selected physical print dimensions
- targeted at 300 pixels per inch of those physical dimensions
- aspect-ratio preserving
- reconstructed or upscaled when source pixels are insufficient
- validated against the authoritative production asset
- downloadable only after that validation permits `print_ready`

Pixel geometry (`production pixels ÷ intended physical inches`) is the authority for the 300 PPI target. Embedded PNG density metadata may be written as a hint to graphics software. It must never be treated as proof of print resolution by itself.

### 16.3 What iHeartPrints controls

The production contract covers only what iHeartPrints actually determines and can verify:

- artwork file format
- transparency
- pixel dimensions
- intended physical print dimensions
- pixel-density target at those dimensions
- the production validation iHeartPrints itself performs

Everything downstream of the file belongs to the decorator, not to iHeartPrints: printer hardware, ink systems, film, powder, pretreatment, RIP configuration, printer-specific color management, ICC profiles, transfer temperature/time/pressure, garment compatibility, and shop-specific production settings. iHeartPrints must not make guarantees about them.

### 16.4 What `print_ready` means

`print_ready` is scoped to the **currently supported apparel raster production profile**. It is not a statement that a file is production-ready for every apparel-decoration method.

For iHeartPrints V1, `print_ready` means:

- a production PNG exists for the current approved production intent
- production geometry satisfies the selected apparel print dimensions
- the pixel geometry satisfies the 300 PPI production target
- transparency requirements for the apparel raster profile passed
- production validation passed on the production asset
- production lineage remains tied to the approved design or prepared upload
- the customer may download that production asset

### 16.5 What `print_ready` does not mean

`print_ready` does **not** guarantee:

- readiness for apparel-decoration methods outside the supported raster profile
- embroidery digitization
- screen-print separations
- sublimation-specific production preparation
- SVG or other vector production
- production PDF
- CMYK
- ICC profiles
- a particular RIP preset
- a particular decorator's press, ink, film, powder, pretreatment, or heat-press settings
- garment or fabric compatibility
- signs, banners, or large-format readiness
- promotional-product readiness
- universal compatibility with every printing method
- perfect OCR or spelling verification
- perfect photographic background removal
- legal ownership or licensing verification

Those may exist as separate future systems elsewhere. They are not the iHeartPrints V1 contract.

The product must not claim that generated artwork is print-ready without validation. Human review and explicit approval remain part of reaching print-ready.

### 16.6 Apparel decoration methods: current versus future

| Method | Category | V1 status |
|---|---|---|
| DTF (direct-to-film) | Apparel raster decoration | Target launch workflow for the supported raster profile |
| DTG (direct-to-garment) | Apparel raster decoration | Target launch workflow for the supported raster profile |
| Sublimation | Apparel / decoration | Not a V1 production contract. V1 performs no sublimation-specific preparation. |
| Screen printing | Apparel decoration | Future production capability. V1 produces no separations or screens and claims no complete screen-print package. The PNG may be useful as design artwork; `print_ready` never implies separation-ready. |
| Embroidery | Apparel decoration | Future production capability. V1 produces no digitized stitch files; `print_ready` never implies embroidery-ready. |
| Other apparel-decoration methods | Apparel decoration | May be added later as explicit production profiles. Not enumerated exhaustively, and not V1 commitments. |
| Signs, banners, large format, promotional products, general commercial printing | Not apparel | Outside the product entirely (§20). Excluded by scope, not by capability. |

Naming a method as a future capability is a scope statement, never a schedule and never a claim of present support.

## 17. Artwork Ownership and Licensing

Ownership and licensing must always be explicit.

The current default is **customer-owned**: exclusive custom artwork associated with a customer. It must not appear publicly or be offered to others without clear authorization.

Additional ownership classes may exist later as architecture, not as current product requirements:

- licensed to customer
- community library
- premium marketplace
- private print shop library

Ownership must never be inferred or left ambiguous.

iHeartPrints does not make absolute legal claims about ownership based only on who operated the software. Ownership and license terms must be explicitly defined through product terms, customer agreements, provider terms, and applicable law. Reaching `print_ready` is not a legal-ownership verification.

## 18. The Print Vault Vision

The Print Vault is a **future** strategic asset of iHeartPrints. It is not a current V1 requirement and must not gate present work.

Every approved design may later become a structured, searchable asset according to its ownership and privacy classification.

Future capabilities may include search, reuse, customization, remixing, licensing, apparel-color variations, seasonal editions, team or chapter variations, and customer-specific derivatives.

If the Print Vault is built, it should grow more useful with every approved design without violating ownership, privacy, or licensing restrictions. Utility must never come at the expense of trust.

## 19. Design Families, Parent Designs, and Variations

Design families are a future capability, not a V1 requirement.

Designs may later form families over time, such as parent design, color variation, garment variation, audience variation, yearly edition, event edition, and customer-specific derivative.

A variation would inherit the relevant Design Brief lineage while recording what changed. Family relationships should make reuse safer and clearer, not dilute authorship or ownership boundaries.

## 20. Explicit Non-Goals

iHeartPrints is not intended to become:

- a Print'em All feature or print-shop operating system
- a physical-product retailer
- a garment catalog, inventory, pricing, cart, checkout, shipping, or fulfillment system
- a SanMar or supplier-catalog shopping experience
- a signs, banners, large-format, or promotional-products design product
- a general commercial-printing platform
- a universal vector-production product
- a general-purpose AI image generator
- a prompt-engineering interface
- a Photoshop replacement
- a Canva clone
- a full manual graphic-design editor
- a stock-image website
- an interface that exposes technical generation settings to ordinary customers
- a platform that prioritizes novelty over printability

These are scope exclusions: they stay out regardless of what the system becomes technically capable of.

Embroidery digitization, screen-print separations, and sublimation-specific preparation are **not** on this list. They are apparel-decoration methods governed by §16.6 — outside current production capability, potentially inside the product later. Absence of capability is not permission to claim support for them today.

Reusable technical architecture may remain broader than the active product. Broader architecture is not permission to broaden the product.

Features that move the product toward these outcomes should be challenged.

## 21. Product Success Criteria

A successful iHeartPrints experience should allow a customer to:

- begin with an idea or an existing apparel file rather than a technical prompt
- understand each question
- receive useful design guidance
- confirm an accurate Design Brief when creating new artwork
- review coherent concepts
- request revisions conversationally
- choose apparel placement and production dimensions
- reach approved artwork without learning design software
- download a validated production PNG for the supported apparel raster profile
- feel as though they worked with an experienced apparel designer

If a feature improves internal sophistication but worsens this experience, it is not progress.

## 22. Authority of the Constitution

This Constitution is the highest-level product document for iHeartPrints.

It governs product strategy, user experience, architecture, artificial-intelligence behavior, artwork handling, ownership, and feature prioritization.

Roadmaps, specifications, technical designs, and implementation decisions must remain consistent with this Constitution.

When another project document conflicts with this Constitution, this document takes precedence unless the Constitution is intentionally amended and the change is recorded in version history.

## 23. Amendment and Version-History Policy

The Constitution may be amended when the product’s enduring identity must intentionally change.

Amendments should be rare, deliberate, and recorded. Each amendment must:

1. state the reason for the change
2. identify the sections affected
3. update the Constitution version
4. preserve a clear version history entry

Temporary tactics, vendor changes, framework migrations, and sprint scope do not justify amending the Constitution. Those belong in separate documents.

### Version History

| Version | Summary |
|---|---|
| 2.1 | Production-authority clarification (sections affected: §4, §7.1, §7.9, new §7.13, §12, §16 restructured as §16.1–§16.6, §20, §21). Separates product scope (apparel design and artwork preparation) from current production capability (§7.13). Names DTF and DTG as the initial supported raster garment-decoration workflows, scopes `print_ready` to the supported raster production profile rather than to apparel generally, states what iHeartPrints controls versus downstream decorator variables, and classifies embroidery, screen printing, and sublimation as apparel methods outside current capability rather than permanent non-goals. Non-apparel categories remain excluded by scope. No change to the V1 deliverable or to product behavior. |
| 2.0 | Product-identity amendment: iHeartPrints is an independent apparel-design product. The customer uses or buys artwork, not a physical garment. V1 deliverable is a validated transparent apparel PNG at selected physical dimensions targeting 300 PPI. Print Vault, ownership-class expansion, and design families are explicitly future. Physical-product commerce, signs/banners/large-format, embroidery digitization, screen-print separations, and vector production are removed from product authority. |
| 1.0 | Initial Constitution establishing iHeartPrints as a conversational print-design platform governed by Design Interviews, Design Briefs, print-ready quality, explicit ownership, and the Print Vault vision. |

## 24. Constitutional Test for Future Features

Every proposed feature should be evaluated against these questions:

1. Does this make it easier to create or prepare professional apparel artwork?
2. Does it reduce customer complexity?
3. Does it reinforce conversation where conversation is the right interaction?
4. Does it strengthen the Design Brief on the Create New path, or honestly preserve uploaded artwork on the Existing Artwork path?
5. Does it improve final artwork quality or apparel print readiness?
6. Would an experienced apparel designer naturally do this?
7. Does it help customers describe what they want rather than how to create it?
8. Does it preserve clear ownership, privacy, and version history?
9. Does it stay inside iHeartPrints as an independent apparel-design product, rather than becoming a retailer, a print-shop operating system, or a general print platform?
10. Is this genuinely part of iHeartPrints, or is it product drift?

Print Vault strength is not a requirement for current V1 work.

Features that fail this test should be reconsidered before implementation.
