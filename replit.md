# Steam Family

A Steam account-sharing / exchange platform ("Steam Family") — members share unused Steam libraries, claim games, and level up through community participation. Includes an admin panel with security/anti-abuse tooling (IP bans, VPN detection, ban system).

## Run & Operate

- Two workflows are configured and run automatically in this Repl: `API Server` (Express API, port 8080) and `Start application` (Vite frontend, port 5000).
- `pnpm --filter @workspace/api-server run dev` — run the API server directly
- `pnpm --filter @workspace/steamshare run dev` — run the frontend directly
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (Replit-managed Postgres is already provisioned and set)

### Vercel database setup

The frontend calls the API through same-origin `/api/*` routes. Vercel therefore needs `DATABASE_URL` and `SESSION_SECRET` in the Vercel project environment, and the database referenced by `DATABASE_URL` must have this project's schema. A reachable but empty database causes the web page's data requests to return 500 errors such as `relation "accounts" does not exist`.

Before the first Vercel deployment, apply the schema using the Vercel database connection in a secure shell or CI environment:

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push
```

Do not add `db:push` to the Vercel build or server startup command. Schema changes should be applied separately, then the Vercel deployment can be rebuilt. The Replit development database is separate from an external Vercel database.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/steamshare` — Vite/React web application
- `artifacts/api-server` — Express API and Vercel serverless app bundle
- `lib/db/src/schema` — Drizzle/PostgreSQL schema source of truth
- `lib/api-spec/openapi.yaml` — API contract source of truth

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
