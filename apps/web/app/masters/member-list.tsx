import { useState } from "react";
import type { ProjectMember } from "@vecta/application";

// ADR 0012 Step 4c — the メンバー master, ported byte-faithful from
// `apps/web/src/MasterScreen.tsx`'s `MemberList`: name / 稼働カレンダー / 日次
// キャパシティ(時間). The capacity input is edited in hours and stored as minutes
// (hours × 60, clamped 1..1440, fallback 480); the name commits on Enter (no
// Escape-revert — deliberately NOT harmonized with the 工程/プロダクト rename). A
// GENERAL viewer's member carries no `dailyCapacityMinutes` (stripped by the
// loader's projection), so the input falls back to the 8h placeholder with the
// control enabled — no role-gating (the server 403s a viewer write; the SPA has
// no disabled state or banner).

/** The メンバー master: name, calendar, and daily capacity (hours). */
export function MemberList({
  members,
  calendars,
  defaultCalendarId,
  editable,
  onAdd,
  onUpdate,
  onDelete,
}: {
  readonly members: readonly ProjectMember[];
  readonly calendars: readonly { readonly id: string; readonly name: string }[];
  readonly defaultCalendarId: string;
  readonly editable: boolean;
  readonly onAdd: (member: ProjectMember) => void;
  readonly onUpdate: (memberId: string, changes: Partial<Omit<ProjectMember, "id">>) => void;
  readonly onDelete: (memberId: string) => void;
}) {
  const [name, setName] = useState("");
  const commitAdd = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    onAdd({
      id: crypto.randomUUID(),
      name: trimmed,
      calendarId: defaultCalendarId,
      dailyCapacityMinutes: 480,
    });
    setName("");
  };
  return (
    <section className="master-section" data-testid="master-section-member">
      <h2 className="master-title">メンバー</h2>
      <ul className="master-list">
        {members.map((member) => (
          <li className="master-row master-row--member" key={member.id} data-testid="member-row">
            <input
              className="master-input"
              defaultValue={member.name}
              disabled={!editable}
              aria-label="メンバー名"
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== "" && value !== member.name) onUpdate(member.id, { name: value });
                else event.target.value = member.name;
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
            <select
              className="master-input master-input--calendar"
              value={member.calendarId}
              disabled={!editable}
              aria-label="稼働カレンダー"
              onChange={(event) => onUpdate(member.id, { calendarId: event.target.value })}
            >
              {calendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
              ))}
            </select>
            <input
              className="master-input master-input--capacity"
              type="number"
              min={1}
              max={24}
              step={0.5}
              defaultValue={(member.dailyCapacityMinutes ?? 480) / 60}
              disabled={!editable}
              aria-label="日次キャパシティ(時間)"
              onBlur={(event) => {
                const hours = Number(event.target.value);
                const minutes = Math.round(hours * 60);
                if (Number.isFinite(hours) && minutes >= 1 && minutes <= 1_440) {
                  if (minutes !== member.dailyCapacityMinutes) {
                    onUpdate(member.id, { dailyCapacityMinutes: minutes });
                  }
                } else {
                  event.target.value = String((member.dailyCapacityMinutes ?? 480) / 60);
                }
              }}
            />
            <span className="master-unit">h/日</span>
            <button
              type="button"
              className="master-delete"
              data-testid="member-delete"
              aria-label={`${member.name} を削除`}
              disabled={!editable}
              onClick={() => onDelete(member.id)}
            >
              削除
            </button>
          </li>
        ))}
        {members.length === 0 && <li className="master-empty">（未登録）</li>}
      </ul>
      <div className="master-add">
        <input
          className="master-input"
          placeholder="メンバーを追加…"
          value={name}
          disabled={!editable}
          aria-label="メンバーを追加"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitAdd();
          }}
        />
        <button
          type="button"
          className="master-add-button"
          data-testid="master-add-member"
          disabled={!editable}
          onClick={commitAdd}
        >
          追加
        </button>
      </div>
    </section>
  );
}
