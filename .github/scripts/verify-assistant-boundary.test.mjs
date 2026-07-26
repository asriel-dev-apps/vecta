import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADAPTER_PATH,
  READ_ONLY_PATHS,
  RULES,
  scanAssistantBoundary,
} from "./verify-assistant-boundary.mjs";

// A scanner is only worth its runtime if it can be shown to FAIL. Each rule below
// gets a violating input as well as a clean one; without the failing case, a
// scanner whose regexes no longer match anything would report a clean run
// forever.

const cleanAdapter = {
  file: ADAPTER_PATH,
  source: 'const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";\nai.run(MODEL_ID, {});\n',
};
const cleanAction = {
  file: READ_ONLY_PATHS[1],
  source: "import { buildProposalDiff } from '@vecta/application';\nexport async function runAssistantAction() {}\n",
};
const cleanRoute = { file: READ_ONLY_PATHS[0], source: "export async function action() {}\n" };
const baseline = [cleanAdapter, cleanAction, cleanRoute];

test("a compliant tree passes with every control satisfied", () => {
  const { violations, controls } = scanAssistantBoundary(baseline);
  assert.deepEqual(violations, []);
  assert.equal(controls.length, RULES.length);
  assert.ok(controls.every((control) => control.satisfied));
});

test("names a model id outside the adapter → violation (A12)", () => {
  const { violations } = scanAssistantBoundary([
    ...baseline,
    { file: "apps/web/app/routes/project.wbs.tsx", source: 'const m = "@cf/meta/llama";' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "provider-confined-to-adapter");
  assert.equal(violations[0].file, "apps/web/app/routes/project.wbs.tsx");
});

test("reaches for the AI binding outside the adapter → violation (A12)", () => {
  const { violations } = scanAssistantBoundary([
    ...baseline,
    { file: "apps/web/app/server/project/other.server.ts", source: "await env.AI.run(x);" },
  ]);
  assert.ok(violations.some((violation) => violation.rule === "provider-confined-to-adapter"));
});

test("the adapter itself may name its own model", () => {
  const { violations } = scanAssistantBoundary(baseline);
  assert.ok(!violations.some((violation) => violation.file === ADAPTER_PATH));
});

test("the proposal action importing the apply helper → violation (A17)", () => {
  const { violations } = scanAssistantBoundary([
    cleanAdapter,
    cleanRoute,
    {
      file: READ_ONLY_PATHS[1],
      source:
        "import { applyCommands } from './apply-commands.server';\nexport async function runAssistantAction() { buildProposalDiff(); }\n",
    },
  ]);
  const write = violations.filter((violation) => violation.rule === "proposal-path-cannot-write");
  assert.ok(write.length >= 1);
  assert.equal(write[0].file, READ_ONLY_PATHS[1]);
});

test("the assistant route calling the command action → violation (A17)", () => {
  const { violations } = scanAssistantBoundary([
    cleanAdapter,
    cleanAction,
    {
      file: READ_ONLY_PATHS[0],
      source: "export const action = (args) => runCommandAction(args);",
    },
  ]);
  assert.ok(violations.some((violation) => violation.rule === "proposal-path-cannot-write"));
});

test("a comment naming the apply endpoint is documentation, not a route to it", () => {
  // The rules are import- and call-shaped on purpose: the design's own prose
  // explains that applying goes through the existing command action, and losing
  // that sentence to satisfy a regex would make the code worse, not safer.
  const { violations } = scanAssistantBoundary([
    cleanAdapter,
    cleanRoute,
    {
      file: READ_ONLY_PATHS[1],
      source:
        "// Applying is the existing runCommandAction, unchanged.\nexport async function runAssistantAction() { buildProposalDiff(); }\n",
    },
  ]);
  assert.deepEqual(violations, []);
});

test("another route may still use the command action — only the proposal path is fenced", () => {
  const { violations } = scanAssistantBoundary([
    ...baseline,
    {
      file: "apps/web/app/routes/project.masters.tsx",
      source: "import { runCommandAction } from '~/server/project/command-action.server';",
    },
  ]);
  assert.deepEqual(violations, []);
});

test("a control that stops matching fails the run, even with zero violations", () => {
  // The scanner pointed at a tree where the adapter no longer names a model:
  // nothing is violated, and that is exactly the state a broken scanner reports.
  const { violations, controls } = scanAssistantBoundary([
    { file: ADAPTER_PATH, source: "// the adapter was gutted\n" },
    cleanAction,
    cleanRoute,
  ]);
  assert.deepEqual(violations, []);
  assert.ok(controls.some((control) => !control.satisfied));
});

test("a missing file fails its control rather than passing vacuously", () => {
  const { controls } = scanAssistantBoundary([cleanAction, cleanRoute]);
  const adapterControl = controls.find(
    (control) => control.rule === "provider-confined-to-adapter",
  );
  assert.equal(adapterControl.satisfied, false);
});
