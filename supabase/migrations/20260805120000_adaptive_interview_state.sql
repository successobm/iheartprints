-- Sprint 2F: adaptive interview.
-- Additive only. Does not edit or rename any previously applied migration.

-- New Design Brief fields the adaptive interview can now gather. All
-- nullable/defaulted so existing rows remain valid without backfill.
alter table public.tshirt_design_briefs
  add column if not exists audience text null,
  add column if not exists purpose text null,
  add column if not exists exclusions text null,
  add column if not exists deferred_sections text[] not null default '{}';

-- print_placement previously always defaulted to 'full_front', which made a
-- real customer choice indistinguishable from an untouched default. Sprint
-- 2F treats "not yet asked" as null instead. Existing rows keep whatever
-- value they already have (a reasonable historical default, not discarded);
-- only new rows going forward start out unset.
alter table public.tshirt_design_briefs
  alter column print_placement drop not null,
  alter column print_placement drop default;

-- New adaptive interview lifecycle phase. Legacy ask_* / skip_references /
-- revision phases remain valid for historical rows and for the (unchanged,
-- out-of-scope-this-sprint) post-concept revision flow; new projects start
-- in 'interviewing' instead of 'ask_product'.
alter type public.conversation_phase add value if not exists 'interviewing';

-- Per-conversation adaptive interview bookkeeping (pending section, ask
-- counts, dismissed advisories). Never used as Design Brief content — pure
-- interview UX state so a reload can resume the adaptive loop without
-- repeating itself.
alter table public.design_conversations
  add column if not exists interview_state jsonb not null default '{}'::jsonb;
