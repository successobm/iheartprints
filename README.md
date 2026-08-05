This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Product Constitution

All product, design, and architecture decisions must align with the
[iHeartPrints Constitution](./IHEARTPRINTS_CONSTITUTION.md).

When a roadmap item, specification, implementation choice, or feature conflicts
with the Constitution, the Constitution takes precedence unless it is formally
amended.

## Concept Generation & Asset Storage (Production Safety)

Real (OpenAI) concept generation must stay **disabled** in production until a
production-safe object-storage asset backend exists. Until then, the current
production-safe environment configuration is:

```
CONCEPT_GENERATION_PROVIDER=placeholder
ASSET_STORAGE_MODE=data_uri
```

Why: generated images are currently stored as `data:` URIs embedded directly
in database rows / JSON records. That's acceptable for local development,
automated tests, placeholder concepts, and architecture verification — it is
**not** acceptable for real production images, since it inflates database
rows, API responses, snapshots, backups, memory usage, and local-store
writes.

The app enforces this itself (`src/lib/config/generation-provider-config.ts`
+ `src/lib/config/asset-storage-config.ts`): setting
`CONCEPT_GENERATION_PROVIDER=openai` in production without a production-safe
`ASSET_STORAGE_MODE` does not silently fall back to placeholder concepts —
it makes generation report itself unavailable with a safe, non-secret error
code, before any provider request is made and before any concept or asset is
persisted.

Enabling real generation in production requires **both**:

1. a real provider configured (`CONCEPT_GENERATION_PROVIDER=openai` +
   `OPENAI_API_KEY`), and
2. a production-safe object-storage `ASSET_STORAGE_MODE` (e.g.
   `supabase_storage` or `s3`) — not yet implemented; see Sprint 2H Part 2A.

See `.env.example` for the full list of variables. Never commit a real API
key.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
