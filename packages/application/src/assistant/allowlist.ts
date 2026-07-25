import type { ProjectCommand } from "../project-state.js";
import type { AssistantMode } from "./ir.js";

/**
 * The command types an assistant proposal may contain (Design 0005 §7.1, ADR 0013
 * Decision 4). This is the last of three independent barriers, and the only one
 * that inspects the finished commands:
 *
 *   1. the IR vocabulary has no `delete` in it (a `.strict()` schema, `ir.ts`),
 *   2. the expander has no branch that builds one (`expander.ts`),
 *   3. this check, immediately before the proposal is handed back.
 *
 * The set narrows twice from requirement 7's 11:
 *   11 − `template.update` (its `subtasks: []` is a delete in an update's
 *        clothing, Design 0005 §7.2)
 *      − `template.add` / `member.add`-from-a-document (required fields the model
 *        would have to invent, Design 0005 §7.3)
 *      = 9. `member.add` survives for CHAT mode, where the capacity comes from
 *        the user's own words rather than from a third party's document.
 *
 * Keeping the list at exactly what the expander can emit — rather than at the
 * wider 11 the requirement permits — means a future expander bug that produces
 * an unintended type is caught here instead of waved through.
 */
export const ALLOWED_COMMAND_TYPES: ReadonlySet<ProjectCommand["type"]> = new Set([
  "task.add",
  "task.update",
  "task.generateSubtasks",
  "member.add",
  "member.update",
  "process.add",
  "process.update",
  "product.add",
  "product.update",
]);

/**
 * Per-mode narrowing, and the second place the trust boundary is enforced
 * (ADR 0013 Decision 3). Ingest mode's IR already cannot express an edit to an
 * existing row — this set says the same thing about the OUTPUT, so a future
 * expander change that starts emitting updates in ingest mode fails here instead
 * of reaching a human's approval screen buried in 100 additions.
 */
export const ALLOWED_COMMAND_TYPES_BY_MODE: Readonly<
  Record<AssistantMode, ReadonlySet<ProjectCommand["type"]>>
> = {
  ingest: new Set(["task.add", "process.add", "product.add"]),
  chat: ALLOWED_COMMAND_TYPES,
};

/** The five the user forbade outright (requirement 7). Named for the control test. */
export const FORBIDDEN_COMMAND_TYPES: readonly ProjectCommand["type"][] = [
  "task.delete",
  "member.delete",
  "process.delete",
  "product.delete",
  "template.delete",
];

export class DisallowedCommandError extends Error {
  readonly commandType: string;
  readonly mode: AssistantMode;

  constructor(commandType: string, mode: AssistantMode) {
    super(`Assistant proposals in ${mode} mode may not contain ${commandType}`);
    this.name = "DisallowedCommandError";
    this.commandType = commandType;
    this.mode = mode;
  }
}

/**
 * Throw unless every command is in the allowlist. Whole-proposal rejection is
 * deliberate: applying the acceptable subset of a proposal that also contained a
 * forbidden command would mean the guard silently changed what the human
 * reviewed (Design 0005 §7.1-3 — "部分適用しない").
 *
 * The control for this check lives in the test suite: a command list containing
 * `task.delete` MUST be rejected. Without it, a check that has quietly stopped
 * checking looks exactly like a check that keeps passing
 * (`~/.claude/memory/audit-needs-a-control.md`).
 */
export function assertCommandsAllowed(
  commands: readonly ProjectCommand[],
  mode: AssistantMode,
): void {
  const allowed = ALLOWED_COMMAND_TYPES_BY_MODE[mode];
  for (const command of commands) {
    if (!allowed.has(command.type)) {
      throw new DisallowedCommandError(command.type, mode);
    }
  }
}
