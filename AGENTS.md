# Agent guidelines

- Surface assumptions only when ambiguity changes the implementation; ask before choosing between materially different outcomes.
- Make the smallest change that satisfies the request. Do not add unrequested abstractions, options, fallbacks, or extensibility.
- Keep diffs scoped, preserve established conventions, and clean up only artifacts introduced by the current change.
- Define concrete success conditions and verify them in proportion to risk. Do not claim completion without evidence.
- Before every push, run the repository security scan and dependency audit.
- Keep implementation work moving autonomously. The user primarily reviews completed UI and interaction checkpoints.
- When the remaining context is approximately 30%, update `../project-docs/vecta/agents/HANDOFF.md` with current state, decisions, verification evidence, and ordered follow-up work before compacting or clearing context.

## Where the documentation lives

This repository is public and carries **no** prose documentation. Specifications, ADRs, design notes, runbooks and this project's handoff live in the private companion repo `asriel-dev-apps/project-docs`, under `vecta/`. Clone it beside this repository, so that the paths below resolve as `../project-docs/vecta/...`. See `docs/README.md`.

Nothing written here — code, tests, or CI — may reference a path under `../project-docs/`; it is documentation for humans and agents only.

## Agent skills

### Issue tracker

Issues, specifications, and the long-running implementation map live in GitHub Issues. See `../project-docs/vecta/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See `../project-docs/vecta/agents/triage-labels.md`.

### Domain docs

This repository uses a multi-context layout for Web, Application, Domain, and Persistence code. See `../project-docs/vecta/agents/domain.md` and `CONTEXT-MAP.md`.
