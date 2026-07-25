# Context map

The whole product is one Cloudflare Worker (`apps/web`) over three pure-TypeScript packages. The
optimizer/simulator Workers and the Python solver services were excised by ADR 0011 and are not part
of the build; see `../project-docs/vecta/adr/0011-effort-based-wbs-evm-realignment.md`.

Paths beginning `../project-docs/` are in the private documentation repo, not here — see
`docs/README.md`. Everything else on this page is in this repository.

- Web Worker (`apps/web`): React Router v8 SSR app plus the Hono `/api` and `/mcp` surfaces, sharing
  one command core. Architecture: `../project-docs/vecta/adr/0012-react-router-cloudflare-ssr-architecture.md`.
- [Application context](packages/application/CONTEXT.md): shared command boundary and project use cases.
- [Domain context](packages/domain/CONTEXT.md): scheduling and earned value rules.
- [Persistence context](packages/persistence/CONTEXT.md): PostgreSQL schema, migrations, and Repository adapters.
- Operations runbooks (`../project-docs/vecta/operations/README.md`): release and rollback, recovery, and monitoring.
- Security operations (`../project-docs/vecta/security/README.md`): identity/secret rotation and privacy/data-lifecycle requirements.

System-wide product rules live in `../project-docs/vecta/mvp-spec.md`. Long-running implementation state lives in the GitHub wayfinder map; session recovery state lives in `../project-docs/vecta/agents/HANDOFF.md`.
