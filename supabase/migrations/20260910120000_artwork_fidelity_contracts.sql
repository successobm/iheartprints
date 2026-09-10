-- Universal Raster Reconstruction Phase R3B: the durable Artwork Fidelity
-- Contract foundation. Additive and forward-only. Builds NO reconstruction,
-- calls NO provider, changes NO DTF/Signs production behavior, and grants
-- NO Print Ready authority of any kind.
--
-- NOT APPLIED to any live database by this change. This repository's
-- convention is to land migration + dependent code together and apply the
-- migration only as part of an explicit, reviewed deploy step, never
-- automatically from a feature change.
--
-- SCHEMA DISCIPLINE AUDIT
--
-- 1. WHAT MUST SURVIVE RELOAD, AND CANNOT ALREADY BE REPRESENTED
--
--    - which asset is the immutable original source this authority is bound
--      to, and that source's own sha256 (so a later re-verification can
--      detect the bytes no longer match what was confirmed)
--    - non-authoritative, machine-PROPOSED preservation facts (a first-pass
--      "I believe this artwork says X" suggestion) kept separate from
--    - customer/operator-CONFIRMED preservation facts: exact wording
--      (verbatim, never normalized), and which protected marks (TM/R/C)
--      are present — the R2 Phase regression proof that "preserve symbols"
--      alone is not enough
--    - WHO confirmed it and when (never a personal identity — this
--      codebase has no user-authentication layer at all, ARCHITECTURE.md
--      §23 — the same narrow customer/operator actor type
--      `sign_preparations.authorized_by` already uses)
--    - a canonical, production-significant identity key over the confirmed
--      facts, so a later fact change (TM -> R) can be detected as making
--      any reconstruction bound to the OLD key stale — the
--      `sign_preparations.plan_key` precedent
--    - deterministic machine EVIDENCE (the source artwork's own content
--      bounding-box aspect ratio) kept explicitly separate from confirmed
--      authority, because a numeric ratio is never something a customer is
--      asked to confirm
--
-- 2. WHY `artwork_preparations` / `sign_preparations` CANNOT REPRESENT IT
--    HONESTLY
--
--    Both records ARE their own workflows: `artwork_preparations`'s status
--    vocabulary ('analyzed'/'prepared'/'approved'), background-isolation
--    diagnostics, and derived transparent PNG are apparel-DTF facts; a
--    fidelity contract has none of them. `sign_preparations`'s ordered
--    physical size, resolution policy, and repair plan are rigid-sign facts
--    a fidelity contract has none of. Most importantly, per the Phase R3A
--    audit: fidelity authority is NOT DTF-specific and NOT Signs-specific —
--    it must be usable, unmodified, by both a future apparel reconstruction
--    path and a future sign reconstruction path. Bolting it onto either
--    existing record would make a narrower table lie about owning a
--    genuinely shared concept, the exact anti-pattern `artwork_preparations`
--    itself was built to avoid (see that migration's own audit).
--    `assets.metadata` is equally wrong: assets are append-only (Constitution
--    §6.11 — no method exists to update an already-created asset's
--    metadata), which cannot represent a fact ledger the customer revises
--    over multiple confirmation/correction rounds.
--
-- 3. SMALLEST ADDITIVE SCHEMA
--
--    ONE table. No enum changes, no new columns on any existing table, and
--    no `print_projects` column of any kind — this record's own existence
--    is the fact, the same "a workflow's presence, not a label column,
--    answers what kind of project this is" rule `artwork_preparations` and
--    `sign_preparations` both already established.
--
--    Protected marks are a CLOSED set (TM/R/C only — Section 4 of the R3B
--    plan is explicit: do not use a generic free-text "symbol" field, and
--    do not invent a full trademark-recognition system). Confirmed wording
--    is a plain text array, stored EXACTLY as confirmed — capitalization
--    and punctuation are part of the authoritative fact, never normalized
--    at rest (a comparison-only normalization, if ever needed, stays a pure
--    function over this column, never a second stored representation).
--    `proposed_facts` is loosely-typed jsonb, narrowed at the
--    `ArtworkFidelityCapability` boundary, exactly like `sign_preparations
--    .inspection`/`.plan` — non-authoritative by construction: nothing
--    reads it as confirmed fact.
--
--    Machine-readable content (QR) is deliberately NOT duplicated here.
--    `sign_preparations.qr_resolutions` already carries the durable,
--    byte-exact QR authority (`SignQrResolutionRecord`), keyed by the SAME
--    `source_asset_id`/`source_sha256` this table also carries — a future
--    consumer joins on that shared key rather than this table embedding or
--    referencing a copy of QR payload authority.

create table if not exists public.artwork_fidelity_contracts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,

  -- 'proposed'  -> machine-proposed facts may exist; NOT reconstruction
  --                authority. Never usable by a future reconstruction
  --                consumer.
  -- 'confirmed' -> a customer/operator explicitly confirmed the preservation
  --                facts below. This, and ONLY this, is reconstruction
  --                authority.
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed')),

  -- The immutable original source this authority is bound to. Never the
  -- customer's uploaded bytes changed in place — a different source means a
  -- new contract, mirroring `sign_preparations.original_asset_id`'s own
  -- "every later transformation derives a NEW asset" rule.
  source_asset_id uuid not null references public.assets (id) on delete restrict,
  -- Measured fresh from the source's own bytes at propose/confirm time, so
  -- a later re-verification can prove the source is still the bytes this
  -- authority was actually established against — the
  -- `print-validation`'s own `sourceBytesSha256` precedent.
  source_sha256 text not null,

  -- Non-authoritative machine evidence — "I believe this artwork says X" —
  -- kept explicitly separate from confirmed authority below. Loosely typed,
  -- narrowed at the capability boundary; never read as a confirmed fact by
  -- anything.
  proposed_facts jsonb null,

  -- CONFIRMED AUTHORITY. Meaningful only when status = 'confirmed'.
  -- Exact strings, in confirmation order — never normalized at rest.
  -- Capitalization and punctuation are part of the authoritative fact.
  confirmed_wording text[] null,
  -- Closed set: 'TM' | 'R' | 'C' (stored as plain ASCII tokens, never the
  -- literal glyphs, so the column survives any encoding boundary honestly —
  -- the domain layer maps these to the real ™ / ® / © glyphs at the
  -- capability boundary, mirroring how `sign_preparations.background
  -- _treatment` stores a plain token rather than a rendered value).
  confirmed_marks text[] null
    check (
      confirmed_marks is null
      or confirmed_marks <@ array['TM', 'R', 'C']::text[]
    ),

  -- WHO confirmed it. Reuses the SAME narrow customer/operator actor type
  -- `sign_preparations.authorized_by` already established — never a
  -- personal identity (this codebase has no user-authentication layer,
  -- ARCHITECTURE.md §23).
  confirmed_by text null
    check (confirmed_by is null or confirmed_by in ('customer', 'operator')),
  confirmed_at timestamptz null,

  -- Deterministic machine EVIDENCE only — never something a customer
  -- confirms. Intended for a future post-reconstruction geometry
  -- comparison; this phase stores the evidence slot without implementing
  -- automatic measurement (Phase R3A Section 13: "do not overbuild").
  source_content_bounding_box_aspect_ratio numeric null,

  -- Canonical, production-significant identity of the CONFIRMED facts —
  -- the `sign_preparations.plan_key` precedent, applied to fidelity
  -- authority instead of a repair plan. Null until confirmed: a proposed
  -- contract has no semantic authority yet to key. Recomputed and compared
  -- by every future consumer before trusting this row — never trusted
  -- merely because it is present.
  contract_key text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists artwork_fidelity_contracts_project_id_created_at_idx
  on public.artwork_fidelity_contracts (project_id, created_at desc);

create index if not exists artwork_fidelity_contracts_source_asset_id_idx
  on public.artwork_fidelity_contracts (source_asset_id);

-- Server-only lockdown, in the same migration that creates the table — the
-- convention 20260811191500 established and
-- `security-lockdown.migration.test.ts` enforces. Two independent controls:
-- RLS with no policies (no row qualifies for any non-bypassing role) AND
-- revoked table privileges for the browser-facing roles.
alter table public.artwork_fidelity_contracts enable row level security;
revoke all privileges on table public.artwork_fidelity_contracts from anon, authenticated;
