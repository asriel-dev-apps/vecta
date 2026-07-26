# Documentation has moved — this absence is deliberate

The specifications, architecture decision records, design notes, runbooks and agent handoffs for
VECTA are **no longer in this repository**. They live in a private companion repository,
`asriel-dev-apps/project-docs`, under its `vecta/` subtree.

This directory is kept, holding only this file, so that the gap reads as a decision rather than as
something lost or forgotten.

## Why

This repository is public. The code is meant to be readable; the reasoning behind it — the domain
model, the decisions and the trade-offs that produced them — is the expensive part, and publishing it
gives it away. Splitting the two keeps the source open without handing over the thinking.

The history was **not** rewritten. Everything committed here before the move is still in `git log`
and is still public. That is accepted: the point is to stop adding, not to retract what is already
out there.

## Where the documents are now

`project-docs` is private, so these paths resolve only for someone who has access to it and has
cloned it beside this repository:

```
~/ghq/github.com/asriel-dev-apps/
  vecta/          <- this repository (public)
  project-docs/   <- the documentation (private)
```

From this repository's root, that is `../project-docs/vecta/`:

| What | Path |
| --- | --- |
| Session state / agent handoff | `../project-docs/vecta/agents/HANDOFF.md` |
| Architecture decision records | `../project-docs/vecta/adr/` |
| Design documents | `../project-docs/vecta/design/` |
| Operations runbooks | `../project-docs/vecta/operations/` |
| Security operations | `../project-docs/vecta/security/` |
| Research and surveys | `../project-docs/vecta/research/` |
| Progress reports | `../project-docs/vecta/reports/` |
| MVP specification | `../project-docs/vecta/mvp-spec.md` |

References elsewhere in this repository — `AGENTS.md`, `CONTEXT-MAP.md`, and one source comment in
`apps/web/app/wbs/cross-project-load.ts` — use that same `../project-docs/vecta/` form.

## What this means if you are reading the public repository

You can build, test and run everything here: nothing in the build, the test suite or CI reads
`docs/`. Only the prose is missing.
