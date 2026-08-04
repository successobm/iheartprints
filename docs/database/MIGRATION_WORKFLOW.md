# Database Migration Workflow

This repository uses Supabase SQL migrations under `supabase/migrations`.
Migration filenames are part of the schema history identity. Treat them as immutable once applied.

## Filename rules

Migration filenames **must** use:

```text
YYYYMMDDHHMMSS_descriptive_name.sql
```

Examples:

```text
20260804130000_sprint1_conversation.sql
20260805101530_add_artwork_versions_indexes.sql
```

### Required constraints

- The timestamp must be a **14-digit UTC** value: `YYYYMMDDHHMMSS`.
- The timestamp must reflect the **actual creation date and time in UTC**.
- Use UTC consistently. Do not mix local timezones into filenames.
- Never use placeholder dates, copied dates, or shortened date-only prefixes such as `20260324_...`.
- The descriptive suffix must be lowercase `snake_case`: `[a-z0-9_]+`.
- Prefer names that describe the **schema change**, not a sprint number alone.
- Every migration file must be source-controlled.

Regex used by CI / local validation:

```text
^\d{14}_[a-z0-9_]+\.sql$
```

## Creating a new migration

1. Read this document.
2. Inspect `supabase/migrations` and identify the latest timestamp.
3. Generate a new UTC timestamp that sorts **after** the current latest migration.
4. Report the proposed filename before creating the file.
5. Create the migration with that exact filename.
6. Review the SQL for:
   - organization scoping (`organization_id` where applicable)
   - RLS policies and lock-down implications
   - forward-only, additive changes whenever possible
7. Run:

```powershell
npm run validate:migrations
```

8. Confirm the final migration order printed by the validator.

## Renaming migrations

- Never rename an applied migration without first checking migration history.
- Check local Supabase, remote Supabase, CI, and any deployed environment before renaming.
- If a migration has **not** been applied anywhere, renaming to a correct UTC timestamp is allowed.
- If a migration **has** been applied, do **not** rename it. That creates history drift.
- Corrections to applied schema must use a **new forward-only migration**.
- Never edit an applied migration to change behavior.

## Applied-migration safety checklist

Before renaming or rewriting a migration file, confirm application status:

| Environment | How to check |
|---|---|
| Local Supabase | `supabase status` / `supabase migration list` when configured |
| Remote Supabase | Linked project migration history / `supabase_migrations.schema_migrations` |
| CI / deploy | Workflow logs, release environment variables, hosted DB history |
| App runtime | Whether the app is pointing at Supabase or a local fallback store |

If status is unknown, assume the migration may be applied and prefer a forward-only fix.

## Validation

Run the filename validator:

```powershell
npm run validate:migrations
```

The validator:

- Inspects `supabase/migrations`
- Requires `^\d{14}_[a-z0-9_]+\.sql$`
- Rejects duplicate timestamps
- Rejects non-chronological timestamp ordering after lexical sort
- Rejects non-SQL files in the migrations directory
- Exits non-zero on failure

Full repository verification:

```powershell
npm run verify
```

## Cursor / agent requirements

When an agent creates or modifies migrations, it must:

1. Read this workflow document first.
2. Inspect existing migrations before creating a new file.
3. Generate a valid 14-digit UTC timestamp.
4. Report the proposed filename before creating it.
5. Confirm whether any rename target has already been applied.
6. Prefer forward-only corrective migrations for applied history.
7. Run `npm run validate:migrations` after migration changes.
8. Report the exact filename and validation result.
9. Never commit or push unless explicitly instructed.
