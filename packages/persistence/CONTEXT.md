# Persistence context

The Persistence context maps PostgreSQL records to the Application and Domain contexts. PostgreSQL is the system of record; the Drizzle schema and a single squashed initial migration are versioned together.

Tenant and project boundaries are enforced by composite foreign keys as well as Repository query predicates. Task effort is stored as integer person-minutes, progress as integer basis points (0–10000), the daily planned-value plot as a sparse jsonb `ISO-date → minutes` map, work and status dates as PostgreSQL `date`, and audit timestamps as `timestamptz` strings. Money is not in the core; it re-enters in Phase 2 as a derived `rate × effort` layer.

The worksheet is a single self-referential `tasks` table: each row carries the 23 typed worksheet columns natively (process, product, review/change references, note, contract, planned effort L, progress T, actual effort W, actual start/finish, and the daily plot), a `parent_task_id` self-foreign-key for the D→F hierarchy, and a nullable `assignee_member_id`. `task_dependencies` holds typed FS/SS/FF/SF edges keyed on tasks; `members` is the simple assignee/capacity table keyed to a `project_calendars` calendar. Composite foreign keys keep every link inside its project.

OIDC principals are keyed by issuer/subject independently of any tenant. Tenant memberships and explicit project memberships bind a human or agent principal to authorization roles. Agent scopes are an allowlist stored with the principal; effective permission is the intersection of the stored allowlist and signed token scopes. Disabled or cross-tenant principals do not resolve to an access grant.

PostgresProjectCommandUnitOfWork locks the WBS row and commits one operation as one revision: the rows the change record names (changed master and task columns, inserted and deleted tasks and dependency edges, the WBS row) plus one `wbs_change` row, the audit event, and the command receipt, in that transaction. It reads Current first and does not rewrite untouched rows. Audit events and command receipts are append-only, enforced by database triggers. Command receipts are keyed by tenant/project/idempotency key; a canonical SHA-256 request hash prevents the same key from representing different commands. Concurrent retries serialize on the Project lock and replay one result. Migrations run from release tooling over a direct PostgreSQL connection, never during a Worker request or through Hyperdrive.

Plan branches, plan freezing, the numeric optimizer, and the probabilistic simulator are deferred to Phase 2/3 and are not part of this schema.

## Language

- **Task**: one worksheet row — a summary parent or a leaf subtask — carrying the 23 typed columns and its daily planned-value plot.
- **Member**: a project-scoped assignee with a working calendar and daily capacity; a task references at most one member.
- **Task dependency**: a typed FS/SS/FF/SF edge with non-negative working-day lag between two tasks.
- **Command receipt**: an append-only tenant/project/idempotency-key record binding a canonical request hash to the resulting revision.
