import { useState } from "react";
import type {
  DependencyType,
  ProjectCommand,
  SubtaskTemplate,
  SubtaskTemplateStep,
} from "@vecta/application";

// ADR 0012 Step 4c — the サブタスクテンプレート master (Design 0003 §E-1), ported
// byte-faithful from `apps/web/src/TemplateSection.tsx`. Templates are a
// project-scoped master: a name plus an ordered list of steps (名称 / 重み% / 依存
// / ラグ). Every edit dispatches the same `template.*` project command the grid
// uses, through the host route's `executeCommand` (now the RR fetcher pipeline).
// Selection and the add-draft are local view state. The panel — its fields,
// labels, testids, keyboard semantics (step-name = Enter only, no Escape),
// clamps (weight %→basis-points ×100 clamp 0..10000 step 0.1; lag Math.trunc ≥0),
// first-step dependency stripping on remove/move, `—` first-step marker, and the
// `（ステップ未登録）` / add-selects-it behaviours — is unchanged from the SPA.

const DEPENDENCY_TYPES: readonly DependencyType[] = ["FS", "SS", "FF", "SF"];

function orderedTemplates(templates: readonly SubtaskTemplate[]): readonly SubtaskTemplate[] {
  return [...templates].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
}

function withoutDependency(step: SubtaskTemplateStep): SubtaskTemplateStep {
  if (step.dependsOnPrev === undefined) return step;
  return { name: step.name, weightBp: step.weightBp };
}

/** The step editor for the selected template: 名称 / 重み% / 依存 / ラグ. */
function StepEditor({
  steps,
  editable,
  onChange,
}: {
  readonly steps: readonly SubtaskTemplateStep[];
  readonly editable: boolean;
  readonly onChange: (steps: readonly SubtaskTemplateStep[]) => void;
}) {
  const totalPercent = steps.reduce((sum, step) => sum + step.weightBp, 0) / 100;

  const replaceStep = (index: number, next: SubtaskTemplateStep) => {
    onChange(steps.map((step, position) => (position === index ? next : step)));
  };
  const addStep = () => {
    onChange([...steps, { name: "Step", weightBp: 0 }]);
  };
  const removeStep = (index: number) => {
    // Dropping a step can leave the new first step carrying a dependency; strip it
    // so the first step never depends on a predecessor.
    const next = steps.filter((_step, position) => position !== index);
    onChange(next.map((step, position) => (position === 0 ? withoutDependency(step) : step)));
  };
  const moveStep = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    onChange(next.map((step, position) => (position === 0 ? withoutDependency(step) : step)));
  };

  return (
    <div className="template-steps" data-testid="template-steps">
      <div className="template-steps-head">
        <h3 className="template-steps-title">サブタスク構成</h3>
        <span className="template-steps-sum" data-testid="template-weight-sum">
          Σ重み {totalPercent}%
        </span>
      </div>
      <ol className="template-step-list">
        {steps.map((step, index) => (
          <li className="template-step-row" key={index} data-testid="template-step-row">
            <span className="template-step-index">{index + 1}</span>
            <input
              className="master-input template-step-name"
              defaultValue={step.name}
              disabled={!editable}
              aria-label="ステップ名称"
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name !== "" && name !== step.name) replaceStep(index, { ...step, name });
                else event.target.value = step.name;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <input
              className="master-input template-step-weight"
              type="number"
              min={0}
              max={100}
              step={0.1}
              defaultValue={step.weightBp / 100}
              disabled={!editable}
              aria-label="重み%"
              onBlur={(event) => {
                const percent = Number(event.target.value);
                const weightBp = Math.min(10_000, Math.max(0, Math.round(percent * 100)));
                if (Number.isFinite(percent) && weightBp !== step.weightBp) {
                  replaceStep(index, { ...step, weightBp });
                } else {
                  event.target.value = String(step.weightBp / 100);
                }
              }}
            />
            <span className="master-unit">%</span>
            {index === 0 ? (
              <span className="template-step-dep template-step-dep--first">—</span>
            ) : (
              <>
                <select
                  className="master-input template-step-dep"
                  value={step.dependsOnPrev?.type ?? ""}
                  disabled={!editable}
                  aria-label="依存"
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "") {
                      replaceStep(index, withoutDependency(step));
                    } else {
                      replaceStep(index, {
                        ...step,
                        dependsOnPrev: {
                          type: value as DependencyType,
                          lagWorkingDays: step.dependsOnPrev?.lagWorkingDays ?? 0,
                        },
                      });
                    }
                  }}
                >
                  <option value="">なし</option>
                  {DEPENDENCY_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
                <input
                  className="master-input template-step-lag"
                  type="number"
                  min={0}
                  step={1}
                  defaultValue={step.dependsOnPrev?.lagWorkingDays ?? 0}
                  disabled={!editable || step.dependsOnPrev === undefined}
                  aria-label="ラグ(営業日)"
                  onBlur={(event) => {
                    if (step.dependsOnPrev === undefined) return;
                    const lag = Math.trunc(Number(event.target.value));
                    if (Number.isFinite(lag) && lag >= 0 && lag !== step.dependsOnPrev.lagWorkingDays) {
                      replaceStep(index, {
                        ...step,
                        dependsOnPrev: { ...step.dependsOnPrev, lagWorkingDays: lag },
                      });
                    } else {
                      event.target.value = String(step.dependsOnPrev.lagWorkingDays);
                    }
                  }}
                />
                <span className="master-unit">営業日</span>
              </>
            )}
            <span className="template-step-actions">
              <button
                type="button"
                className="template-step-move"
                aria-label="上へ移動"
                disabled={!editable || index === 0}
                onClick={() => moveStep(index, -1)}
              >
                ▲
              </button>
              <button
                type="button"
                className="template-step-move"
                aria-label="下へ移動"
                disabled={!editable || index === steps.length - 1}
                onClick={() => moveStep(index, 1)}
              >
                ▼
              </button>
              <button
                type="button"
                className="master-delete"
                data-testid="template-step-delete"
                aria-label="ステップを削除"
                disabled={!editable}
                onClick={() => removeStep(index)}
              >
                削除
              </button>
            </span>
          </li>
        ))}
        {steps.length === 0 && <li className="master-empty">（ステップ未登録）</li>}
      </ol>
      <button
        type="button"
        className="master-add-button template-step-add"
        data-testid="template-step-add"
        disabled={!editable}
        onClick={addStep}
      >
        ステップを追加
      </button>
    </div>
  );
}

/**
 * The サブタスクテンプレート master section (Design 0003 §E-1) shown inside the マスタ
 * screen. It renders the template list + selected template's step editor and
 * dispatches the same `template.*` commands the standalone screen used, through the
 * host screen's `executeCommand`. Selection and the add-draft are local view state.
 */
export function TemplateSection({
  templates,
  editable,
  executeCommand,
}: {
  readonly templates: readonly SubtaskTemplate[];
  readonly editable: boolean;
  readonly executeCommand: (command: ProjectCommand) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const ordered = orderedTemplates(templates);
  const selected = ordered.find((template) => template.id === selectedId) ?? ordered[0] ?? null;
  const nextSortOrder = templates.reduce((max, item) => Math.max(max, item.sortOrder), -1) + 1;

  const commitAdd = () => {
    const name = draft.trim();
    if (name === "") return;
    const id = crypto.randomUUID();
    executeCommand({
      type: "template.add",
      template: { id, name, sortOrder: nextSortOrder, subtasks: [] },
    });
    setSelectedId(id);
    setDraft("");
  };

  return (
    <section className="master-section master-templates" data-testid="master-section-template">
      <h2 className="master-title">サブタスクテンプレート</h2>
      <div className="template-body" data-testid="template-screen">
        <section className="master-subsection template-list-section">
          <h3 className="master-subtitle">テンプレート</h3>
          <ul className="master-list">
            {ordered.map((template) => (
              <li
                className={`template-list-row${template.id === selected?.id ? " template-list-row--active" : ""}`}
                key={template.id}
                data-testid="template-list-row"
              >
                <button
                  type="button"
                  className="template-select"
                  data-testid="template-select"
                  aria-pressed={template.id === selected?.id}
                  onClick={() => setSelectedId(template.id)}
                >
                  {template.name}
                </button>
                <input
                  className="master-input template-rename"
                  defaultValue={template.name}
                  disabled={!editable}
                  aria-label="テンプレート名"
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name !== "" && name !== template.name) {
                      executeCommand({ type: "template.update", templateId: template.id, changes: { name } });
                    } else {
                      event.target.value = template.name;
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    else if (event.key === "Escape") {
                      event.currentTarget.value = template.name;
                      event.currentTarget.blur();
                    }
                  }}
                />
                <button
                  type="button"
                  className="master-delete"
                  data-testid="template-delete"
                  aria-label={`${template.name} を削除`}
                  disabled={!editable}
                  onClick={() => executeCommand({ type: "template.delete", templateId: template.id })}
                >
                  削除
                </button>
              </li>
            ))}
            {ordered.length === 0 && <li className="master-empty">（未登録）</li>}
          </ul>
          <div className="master-add">
            <input
              className="master-input"
              placeholder="テンプレートを追加…"
              value={draft}
              disabled={!editable}
              aria-label="テンプレートを追加"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitAdd();
              }}
            />
            <button
              type="button"
              className="master-add-button"
              data-testid="template-add"
              disabled={!editable}
              onClick={commitAdd}
            >
              追加
            </button>
          </div>
        </section>
        <section className="master-subsection template-editor-section" data-testid="template-editor">
          {selected === null ? (
            <p className="master-empty">左のリストからテンプレートを選択してください。</p>
          ) : (
            <>
              <h3 className="master-subtitle">{selected.name}</h3>
              <StepEditor
                steps={selected.subtasks}
                editable={editable}
                onChange={(steps) =>
                  executeCommand({
                    type: "template.update",
                    templateId: selected.id,
                    changes: { subtasks: steps },
                  })
                }
              />
            </>
          )}
        </section>
      </div>
    </section>
  );
}
