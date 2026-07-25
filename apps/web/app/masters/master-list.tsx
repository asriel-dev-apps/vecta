import { useState } from "react";

// ADR 0012 Step 4c — the name-only master list (工程 / プロダクト), ported
// byte-faithful from `apps/web/src/MasterScreen.tsx`'s `MasterList`: add / rename
// / delete, with the same fields, labels, Japanese testids, keyboard semantics
// (rename = Enter-commit / Escape-revert; add = Enter-commit), ordering
// (sortOrder then id.localeCompare), and `（未登録）` empty state. The only change
// from the SPA is provenance (the host now seeds it from the route loader and
// dispatches through the RR fetcher); the panel itself is unchanged.

/** A name-only master list (工程 / プロダクト): add / rename / delete. */
export function MasterList({
  title,
  addLabel,
  items,
  editable,
  onAdd,
  onRename,
  onDelete,
}: {
  readonly title: string;
  readonly addLabel: string;
  readonly items: readonly { readonly id: string; readonly name: string; readonly sortOrder: number }[];
  readonly editable: boolean;
  readonly onAdd: (name: string) => void;
  readonly onRename: (id: string, name: string) => void;
  readonly onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const ordered = [...items].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
  const commitAdd = () => {
    const name = draft.trim();
    if (name === "") return;
    onAdd(name);
    setDraft("");
  };
  return (
    <section className="master-section" data-testid={`master-section-${title}`}>
      <h2 className="master-title">{title}</h2>
      <ul className="master-list">
        {ordered.map((item) => (
          <li className="master-row" key={item.id} data-testid="master-row">
            <input
              className="master-input"
              defaultValue={item.name}
              disabled={!editable}
              aria-label={`${title} 名`}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name !== "" && name !== item.name) onRename(item.id, name);
                else event.target.value = item.name;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                else if (event.key === "Escape") {
                  event.currentTarget.value = item.name;
                  event.currentTarget.blur();
                }
              }}
            />
            <button
              type="button"
              className="master-delete"
              data-testid="master-delete"
              aria-label={`${item.name} を削除`}
              disabled={!editable}
              onClick={() => onDelete(item.id)}
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
          placeholder={addLabel}
          value={draft}
          disabled={!editable}
          aria-label={addLabel}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitAdd();
          }}
        />
        <button
          type="button"
          className="master-add-button"
          data-testid={`master-add-${title}`}
          disabled={!editable}
          onClick={commitAdd}
        >
          追加
        </button>
      </div>
    </section>
  );
}
