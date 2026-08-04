# iHeartPrints Constitution

**Version 1.0**

## 1. Purpose of the Constitution

This Constitution defines the enduring product identity of iHeartPrints.

It exists to keep the product coherent as features evolve, teams change, and technology advances. It describes what iHeartPrints is for, how it should behave, what it must never become, and how future decisions should be judged.

This document is intentionally timeless. It does not prescribe a specific vendor, host, framework, sprint plan, or temporary roadmap. Those belong in separate operational documents.

## 2. Why iHeartPrints Exists

Creating print-ready artwork is hard for people who are not professional designers.

Customers know what they want to accomplish—a shirt for a team, a logo for an event, artwork for a product—but they rarely know how to translate that intent into production-ready files. Traditional design tools demand expertise. Generic AI image tools demand prompt engineering and still leave customers responsible for printability, dimensions, backgrounds, contrast, and production constraints.

iHeartPrints exists to close that gap.

It helps customers and print shops move from an idea to professional, print-ready artwork through guided conversation, structured design understanding, and production-aware guidance.

## 3. Vision

Anyone with an idea for printed artwork should be able to create something a professional print shop would be proud to produce—without learning design software, print engineering, or image-generation mechanics.

## 4. Mission

iHeartPrints is a conversational print-design platform that helps customers and print shops create professional, print-ready artwork.

Unlike traditional AI image generators that begin with a prompt, iHeartPrints begins with a Design Interview.

The goal is not merely to generate images.

The goal is to produce artwork that is ready to print.

## 5. Product Philosophy

iHeartPrints should feel like working with an experienced print designer.

Customers should describe what they want to accomplish, not how to create it. They should never need to understand DPI, PNG, SVG, vector formats, transparent backgrounds, print dimensions, resolution, image models, or generation settings.

The product succeeds when the customer focuses on meaning, audience, style, wording, and purpose—while the system quietly handles the technical and production work required to make the artwork printable.

Conversation is the product. Artwork is the outcome.

## 6. Core Principles

### 6.1 Print Ready First

Customers are not buying AI. They are buying artwork that can be printed.

Every major product decision should improve the path from intent to production-ready artwork. Novelty, spectacle, or model capability that does not improve print readiness is secondary.

### 6.2 Conversation Is the Product

The primary experience is conversation with a Design Assistant that behaves like an experienced print designer.

The product should not feel like operating design software or prompting an image model. It should feel like being interviewed, guided, and advised by someone who understands both design and print production.

### 6.3 Conversation Over Forms

Prefer natural conversation and one question at a time over complicated forms.

Forms may support the experience when they reduce friction, but they must not replace the Design Interview as the primary way customers express intent.

### 6.4 Understand Before Generating

Never generate artwork from incomplete information.

The Design Interview must gather and confirm the Design Brief before concept generation. Speed that skips understanding creates waste, revisions, and unprintable results.

### 6.5 The Design Brief Is the Source of Truth

Every design, concept, revision, approved file, production file, and future variation must originate from a versioned Design Brief.

Images are outputs of the Design Brief. They never replace it as the authoritative record of customer intent and production requirements.

### 6.6 Hide Technical Complexity

The system determines technical settings automatically.

Users should not have to select image models, file formats, DPI, resolution, export settings, or other production mechanics. When a technical choice must be explained, explain it in plain language and only when it helps the customer make a meaningful decision.

### 6.7 Print Before AI

The product should emphasize printing and the customer’s desired outcome, not artificial intelligence.

AI is a means. Print-ready artwork is the promise.

### 6.8 Product Intelligence

The Design Assistant should not blindly follow poor design instructions.

It should identify issues such as weak contrast, unreadable wording, unsuitable colors, excessive detail, decoration limitations, and production risks. It should recommend improvements in plain language and help customers make better decisions without shaming them or exposing technical jargon.

### 6.9 Production Awareness

Design requirements vary by garment or product, print location, shirt or product color, and production method—including screen printing, DTF, DTG, embroidery, sublimation, signage, promotional products, engraving, and other methods.

The customer should not need to understand these limitations. The system should guide them naturally, adapting questions and recommendations to the product and method involved.

### 6.10 Concepts Must Respect the Brief

Generated concepts must not randomly change the approved style.

Concept variation should primarily come from layout, composition, typography, graphic arrangement, and visual hierarchy. All concepts must remain faithful to the approved Design Brief.

### 6.11 Version Everything

Design Briefs, generated concepts, revisions, approved artwork, and production files must be versioned.

Prior versions should remain available and must not be destructively overwritten. Continuity and recoverability are part of professional trust.

### 6.12 Print Quality Is Mandatory

Approved artwork must eventually satisfy standards including:

- correct spelling
- required text verification
- visual balance
- readability
- appropriate contrast
- appropriate audience and product fit
- sufficient resolution
- transparent background where required
- correct dimensions
- safe artwork boundaries
- suitable line thickness
- suitable font size
- production-method compatibility
- customer approval

No concept should be described as print ready merely because an image model generated it.

## 7. The Role of the Design Assistant

The Design Assistant is the customer’s guide through iHeartPrints.

It should behave as an experienced print designer whose responsibilities include:

- asking the right questions
- identifying missing information
- translating customer ideas into structured Design Briefs
- recommending improvements
- preventing avoidable production problems
- explaining choices in plain language
- maintaining continuity through revisions
- preserving customer intent
- preparing artwork for production
- adapting to the customer’s knowledge level

The Design Assistant must never require customers to learn prompt engineering. It should meet customers where they are, elevate the quality of the outcome, and remain accountable to the Design Brief.

## 8. Conversation as the Primary Product Experience

The home of iHeartPrints is conversation.

The interface may present summaries, concept cards, previews, approvals, and downloads, but those are supporting surfaces. The product’s center of gravity is a guided dialogue that gathers intent, confirms understanding, proposes directions, and carries revisions forward.

Conversation should be:

- one primary question at a time when discovery is underway
- adaptive based on prior answers
- respectful of the customer’s time
- clear about what happens next
- continuous across interview, concepts, revisions, and approval

## 9. The Design Interview

The Design Interview is the heart of iHeartPrints.

It is how the product earns the right to generate artwork. It gathers information naturally, including:

- what is being printed
- who it is for
- purpose or occasion
- desired style
- graphics or imagery
- colors
- required wording
- product color
- print location
- production constraints
- references
- exclusions
- anything else that matters

The interview should adapt based on prior answers and should not ask unnecessary questions. It should clarify ambiguity, surface risks early, and help the customer make better choices.

At the end of the interview, the system should present a clear Design Summary and require customer confirmation before concept generation.

## 10. The Design Brief as the Authoritative Source of Truth

The Design Brief is the structured, versioned record of design intent and production requirements.

It is the authoritative domain object for iHeartPrints. Concepts, revisions, approvals, production files, and future variations must be traceable to a Design Brief version.

Chat messages may inform the brief. Images may illustrate the brief. Neither replaces the brief.

When conversation and artwork appear to disagree, the confirmed Design Brief governs until the customer intentionally updates and confirms a new version.

## 11. Separation of Design Intent and Production Requirements

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

What is necessary to manufacture the artwork successfully.

Examples:

- product
- product color
- decoration method
- print location
- dimensions
- color limits
- minimum detail size
- required output type
- background requirements

The system should connect these layers without exposing unnecessary complexity. Customers should experience one coherent conversation; the product should maintain the structured separation behind the scenes.

## 12. Product and Print Intelligence

iHeartPrints must understand that good artwork is not only visually appealing—it must survive the realities of production.

The Design Assistant should reason about product type, decoration method, placement, color relationships, readability, detail density, and other constraints that affect whether artwork can be printed well.

Guidance should be practical and plainspoken. The product should prevent avoidable failure modes before they become expensive revisions or unusable files.

## 13. Concept-Generation Rules

Concept generation begins only after the Design Brief has been confirmed.

Concepts must:

- remain faithful to the confirmed Design Brief
- preserve required wording as structured data, not as disposable decoration
- vary primarily through layout, composition, typography, graphic arrangement, and visual hierarchy
- avoid random style drift
- be presented as options for human review, not as guaranteed print-ready finals

The purpose of concepts is to explore strong interpretations of the brief, not to invent a different brief.

## 14. Revision and Versioning Principles

Revisions continue the same design relationship. They do not restart from zero unless the customer intentionally begins a new design.

Every meaningful change to the Design Brief, every generated concept, every revision, every approval, and every production file should create or reference a durable version.

Prior versions remain available. The system must not silently overwrite history. Customers and print shops should be able to return to earlier decisions with confidence.

## 15. Print-Ready Quality Standards

Print readiness is earned through validation, review, and confirmation—not assumed from generation.

Artwork may only be treated as print ready when it satisfies the applicable quality standards for the product and production method, including spelling and required-text checks, visual balance, readability, contrast, audience and product fit, resolution, background requirements, dimensions, safe boundaries, line thickness, font size, production compatibility, and customer approval.

The product must not claim that generated artwork is guaranteed print ready without validation. Early versions require human review before artwork is considered print ready.

## 16. Artwork Ownership and Licensing

Ownership and licensing must always be explicit.

Supported categories include:

### Customer-Owned

Exclusive custom artwork associated with a customer. It must not appear publicly or be offered to others without clear authorization.

### Licensed to Customer

Artwork used under a defined customer license rather than transferred as exclusive ownership.

### Community Library

Generic artwork available for broader use under clear terms.

### Premium Marketplace

Artwork available for paid licensing or purchase under clear terms.

### Private Print Shop Library

Artwork owned or controlled by a specific print shop and available only to that shop or its customers under clear terms.

Ownership must never be inferred or left ambiguous.

iHeartPrints does not make absolute legal claims about ownership based only on who operated the software. Ownership and license terms must be explicitly defined through product terms, customer agreements, provider terms, and applicable law.

## 17. The Print Vault Vision

The Print Vault is a long-term strategic asset of iHeartPrints.

Every approved design may become a structured, searchable asset according to its ownership and privacy classification.

Future capabilities may include search, reuse, customization, remixing, licensing, product adaptation, color variations, seasonal editions, team or chapter variations, and customer-specific derivatives.

The Print Vault should grow more useful with every approved design without violating ownership, privacy, or licensing restrictions. Utility must never come at the expense of trust.

## 18. Design Families, Parent Designs, and Variations

Designs should be able to form families over time, such as:

- parent design
- color variation
- product variation
- audience variation
- yearly edition
- event edition
- customer-specific derivative

A variation inherits the relevant Design Brief lineage while recording what changed. Family relationships should make reuse safer and clearer, not dilute authorship or ownership boundaries.

## 19. Long-Term Production Workflow Vision

The long-term workflow may extend beyond artwork creation:

Approved Design → Product Selection → Sizes and Colors → Supplier Availability → Decoration Method → Pricing → Checkout → Production Order → Print Shop → Fulfillment

This is a future extension of the mission. The Constitution remains focused on the simplest and most important path: from customer intent to professional, production-ready artwork.

Later commerce and fulfillment capabilities must reinforce that path, not distract from it.

## 20. Explicit Non-Goals

iHeartPrints is not intended to become:

- a general-purpose AI image generator
- a prompt-engineering interface
- a Photoshop replacement
- a Canva clone
- a full manual graphic-design editor
- a stock-image website
- an interface that exposes technical generation settings to ordinary customers
- a platform that prioritizes novelty over printability

Features that move the product toward these outcomes should be challenged.

## 21. Product Success Criteria

A successful iHeartPrints experience should allow a customer to:

- begin with an idea rather than a technical prompt
- understand each question
- receive useful design guidance
- confirm an accurate Design Brief
- review coherent concepts
- request revisions conversationally
- reach approved artwork without learning design software
- receive production-ready files without choosing technical settings
- feel as though they worked with an experienced print designer

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
| 1.0 | Initial Constitution establishing iHeartPrints as a conversational print-design platform governed by Design Interviews, Design Briefs, print-ready quality, explicit ownership, and the Print Vault vision. |

## 24. Constitutional Test for Future Features

Every proposed feature should be evaluated against these questions:

1. Does this make it easier to create professional, print-ready artwork?
2. Does it reduce customer complexity?
3. Does it reinforce conversation?
4. Does it strengthen the Design Brief?
5. Does it improve final artwork quality or production readiness?
6. Would an experienced print designer naturally do this?
7. Does it help customers describe what they want rather than how to create it?
8. Does it preserve clear ownership, privacy, and version history?
9. Does it strengthen the long-term value of the Print Vault?
10. Is this genuinely part of iHeartPrints, or is it product drift?

Features that fail this test should be reconsidered before implementation.
