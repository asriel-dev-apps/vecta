import { useMemo, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";
import { calculateBaselineEvm, type EffortRatio } from "@vecta/domain";
import {
  projectEvmDashboard,
  projectEvmTrend,
  type EvmDashboardProjection,
  type EvmDashboardRow,
  type ProjectionRole,
  type ProjectState,
} from "@vecta/application";
import { EvmTrendChart } from "./evm-trend-chart";
import type { BaselineView } from "~/server/project/load-project-view.server";

/**
 * The EVM dashboard (design 0007 — Step 4). One table whose rows mean either the
 * first-level parent tasks or the members, switched in place; ten effort columns
 * and a mini S-curve; one as-of date at the top that every column follows.
 *
 * Derived isomorphically from the project state, exactly as the WBS grid is: the
 * route sends the role-scoped state view and both sides call
 * `projectEvmDashboard` on it, so the table is server-rendered and the payload
 * carries no second copy of it. Changing the as-of date is therefore local state,
 * not a round trip.
 */

/** Rows are never sorted here. Design 0007 §2: the WBS projection owns row order. */
export type EvmSegment = "task" | "member" | "change";

/**
 * The segment buttons. "変更別" groups by the first-level ancestor's NAME
 * (ADR 0011 Decision 8), which the user confirmed on 2026-08-06 is what the
 * reference spreadsheet does — same-named rows merge. With every name distinct
 * it is identical to 親タスク別, and that is expected rather than a fault.
 */
const SEGMENTS = [
  { key: "task", label: "親タスク別", caption: "親タスク", testId: "evm-segment-task" },
  { key: "member", label: "人別", caption: "メンバー", testId: "evm-segment-member" },
  { key: "change", label: "変更別", caption: "変更", testId: "evm-segment-change" },
] as const;

/**
 * Effort or money (Design 0010). The COLUMNS do not change — the reference
 * spreadsheet has no money column and Design 0003 §B-1 forbids inventing one —
 * so the cost layer is a change of unit on the same ten columns, which is what
 * ADR 0011 Decision 1 means by calling it optional.
 */
export type EvmUnit = "days" | "money";

export interface EvmDashboardProps {
  /** The role-scoped project view the route loaded. */
  readonly project: ProjectState;
  readonly projectionRole: ProjectionRole;
  /** Today, resolved server-side (see `as-of-date.ts`) — the initial as-of date. */
  readonly today: string;
  /** The latest published baseline, or `null` if the plan has never been frozen. */
  readonly baseline: BaselineView | null;
  /** The project revision the view was loaded at — the publish command's pin. */
  readonly revision: string;
  /**
   * Leaves whose daily plot disagrees with their estimate. Publishing freezes them
   * at whatever the PLOT says (BAC comes from the plot, not the estimate), so the
   * count is shown before the button can be used — see Design 0009 §3.1.
   */
  readonly unplottedLeafCount: number;
}

/**
 * CPI/SPI below this get the row's quiet risk marker (design 0007 §5 C-10). A
 * threshold has to be some number; 0.9 is the conventional EVM watch line, and it
 * is deliberately not 1.0 — nearly every row sits a little under 1.0, and a
 * marker that fires on nearly every row is what buries the rows that matter.
 */
const RISK_INDEX_THRESHOLD = 0.9;

/** How far from 1.0 the CPI/SPI deviation bar runs before it clamps (§5 B-4). */
const INDEX_BAR_RANGE = 0.5;

const SPARKLINE_WIDTH = 88;
const SPARKLINE_HEIGHT = 22;

const MS_PER_DAY = 86_400_000;

function dayIndex(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / MS_PER_DAY);
}

/**
 * Person-days, always to one decimal so the decimal points line up down the
 * column (§5 A-1). Rounded BEFORE the sign is read, so a value that displays as
 * zero can never come out as "-0.0" wearing a ▼.
 */
function formatDays(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1);
}

/**
 * EAC/ETC — person-days, but undefined whenever CPI is. `"-"` renders as an em
 * dash, matching the WBS totals strip.
 */
function formatDayForecast(value: EffortRatio): string {
  return value === "-" ? "—" : formatDays(value);
}

/**
 * Money, in the project currency's MINOR UNIT, grouped in threes.
 *
 * Deliberately not `Intl.NumberFormat`: this table is rendered on the server and
 * hydrated on the client, and node's ICU and workerd's need not agree on
 * grouping or symbols — a mismatch would be a hydration error in production and
 * nowhere else. There is no per-currency decimal table either; JPY's minor unit
 * is the yen, and a table nobody exercises is a table nobody checks.
 */
function formatMinor(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded).toString();
  let grouped = "";
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ",";
    grouped += digits[index];
  }
  return `${sign}${grouped}`;
}

function formatMoneyForecast(value: EffortRatio): string {
  return value === "-" ? "—" : formatMinor(value);
}

/** −1 / 0 / +1 of the DISPLAYED value, so the marker agrees with the digits. */
function displayedSign(value: number): number {
  return Math.sign(Math.round(value * 10) / 10);
}

/**
 * A variance cell: sign carried by BOTH a symbol and a colour (§5 B-5), so it
 * survives a colour-blind reader and a black-and-white print. Positive is good
 * for SV and CV alike (ahead of plan / under budget).
 */
function VarianceCell({
  value,
  format,
  group = false,
}: {
  readonly value: number;
  /** Person-days or minor units — the sign logic is identical, the digits are not. */
  readonly format: (value: number) => string;
  /** Starts the variance group — draws the hairline that separates it. */
  readonly group?: boolean;
}): ReactNode {
  const sign = displayedSign(value);
  const tone = sign > 0 ? "ok" : sign < 0 ? "risk" : "flat";
  return (
    <td
      className={`evm-cell evm-cell--num evm-cell--${tone}${group ? " evm-cell--group" : ""}`}
    >
      <span className="evm-variance__mark" aria-hidden="true">
        {sign > 0 ? "▲" : sign < 0 ? "▼" : ""}
      </span>
      <span className="evm-variance__value">
        {sign > 0 ? "+" : ""}
        {format(value)}
      </span>
    </td>
  );
}

/**
 * A CPI/SPI cell: the number, with a deviation bar behind it whose centre is 1.0
 * (§5 B-4). The number is what is read; the bar only makes "above or below 1.0"
 * visible without reading, which is the whole meaning of these two columns.
 */
function IndexCell({ value }: { readonly value: EffortRatio }): ReactNode {
  if (value === "-") {
    return <td className="evm-cell evm-cell--num evm-cell--muted">—</td>;
  }
  const deviation = Math.max(-INDEX_BAR_RANGE, Math.min(INDEX_BAR_RANGE, value - 1));
  const width = (Math.abs(deviation) / INDEX_BAR_RANGE) * 50;
  const tone = deviation >= 0 ? "ok" : "risk";
  return (
    <td className="evm-cell evm-cell--num evm-cell--index">
      <span
        className={`evm-index__bar evm-index__bar--${tone}`}
        style={{ width: `${width}%`, left: deviation >= 0 ? "50%" : `${50 - width}%` }}
        aria-hidden="true"
      />
      <span className="evm-index__tick" aria-hidden="true" />
      <span className="evm-index__value">{value.toFixed(2)}</span>
    </td>
  );
}

/**
 * The mini S-curve (§5 B-6): cumulative PV over the plan, a marker at the as-of
 * date, and a dot at the EV level reached by then. The vertical gap between the
 * dot and the curve IS the schedule variance; the horizontal gap to where the
 * curve last held that value is the slip in time, which no single index shows.
 *
 * There is no EV LINE, and there cannot be one: an EV history needs a progress
 * history, and the model stores one current progress figure per task. Drawing a
 * fabricated EV curve would look like measurement, so the EV appears as the one
 * point that is actually known.
 *
 * Every row is drawn on the projection-wide date axis, not its own, so two rows'
 * curves can be compared; the y axis is per-row (0…BAC), because rows differ in
 * size by orders of magnitude and a shared y axis would flatten the small ones
 * into the baseline.
 */
function Sparkline({
  row,
  projection,
}: {
  readonly row: EvmDashboardRow;
  readonly projection: EvmDashboardProjection;
}): ReactNode {
  const { planStart, planEnd, statusDate } = projection;
  if (planStart === null || planEnd === null || row.curve.length === 0 || row.bac <= 0) {
    return <td className="evm-cell evm-cell--curve" />;
  }

  const firstDay = dayIndex(planStart);
  const span = Math.max(1, dayIndex(planEnd) - firstDay);
  const x = (day: number): number =>
    (Math.max(0, Math.min(span, day - firstDay)) / span) * SPARKLINE_WIDTH;
  const y = (days: number): number =>
    SPARKLINE_HEIGHT - (Math.max(0, Math.min(row.bac, days)) / row.bac) * SPARKLINE_HEIGHT;

  // The curve starts on the day BEFORE the row's first planned day, at zero, so
  // the first step reads as a rise rather than as a value that was always there.
  const points = [
    `${x(dayIndex(row.curve[0]!.date) - 1)},${y(0)}`,
    ...row.curve.map((point) => `${x(dayIndex(point.date))},${y(point.pv)}`),
  ].join(" ");
  const asOfX = x(dayIndex(statusDate));

  return (
    <td className="evm-cell evm-cell--curve">
      <svg
        className="evm-curve"
        width={SPARKLINE_WIDTH}
        height={SPARKLINE_HEIGHT}
        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
        // Redundant with the numeric columns beside it: everything this draws is
        // already read out as PV, EV and SV. Announcing it again would only make
        // the row longer to listen to.
        aria-hidden="true"
      >
        <line className="evm-curve__asof" x1={asOfX} y1={0} x2={asOfX} y2={SPARKLINE_HEIGHT} />
        <polyline className="evm-curve__pv" points={points} />
        <circle
          className={`evm-curve__ev evm-curve__ev--${displayedSign(row.sv) < 0 ? "risk" : "ok"}`}
          cx={asOfX}
          cy={y(row.ev)}
          r={2.5}
        />
      </svg>
    </td>
  );
}

const DAY_COLUMNS = [
  { key: "bac", label: "BAC", band: "bac" },
  { key: "pv", label: "PV", band: "pv" },
  { key: "ev", label: "EV", band: "ev" },
  { key: "ac", label: "AC", band: "ac" },
] as const;

function MetricRow({
  row,
  projection,
  caption,
  unit,
}: {
  readonly row: EvmDashboardRow;
  readonly projection: EvmDashboardProjection;
  readonly caption: string;
  readonly unit: EvmUnit;
}): ReactNode {
  // In money, the row IS its money block. A row with nothing priced has none,
  // and renders em dashes rather than zeroes — "nobody said what this costs" is
  // not "this costs nothing" (Design 0010 §4).
  const money = unit === "money" ? row.money : null;
  const shown = money ?? row;
  const priced = unit === "days" || money !== null;
  const format = unit === "days" ? formatDays : formatMinor;
  const formatForecast = unit === "days" ? formatDayForecast : formatMoneyForecast;
  const atRisk =
    (shown.cpi !== "-" && shown.cpi < RISK_INDEX_THRESHOLD) ||
    (shown.spi !== "-" && shown.spi < RISK_INDEX_THRESHOLD);
  return (
    <tr
      className={`evm-row evm-row--${row.kind}${atRisk ? " evm-row--risk" : ""}`}
      data-testid={`evm-row-${row.key}`}
    >
      <th scope="row" className="evm-cell evm-cell--name">
        {caption}
      </th>
      {DAY_COLUMNS.map((column) => (
        <td key={column.key} className="evm-cell evm-cell--num">
          {priced ? format(shown[column.key]) : "—"}
        </td>
      ))}
      {priced ? (
        <>
          <VarianceCell value={shown.sv} format={format} group />
          <VarianceCell value={shown.cv} format={format} />
        </>
      ) : (
        <>
          <td className="evm-cell evm-cell--num evm-cell--muted evm-cell--group">—</td>
          <td className="evm-cell evm-cell--num evm-cell--muted">—</td>
        </>
      )}
      <IndexCell value={priced ? shown.cpi : "-"} />
      <IndexCell value={priced ? shown.spi : "-"} />
      <td className="evm-cell evm-cell--num evm-cell--group">
        {priced ? formatForecast(shown.eac) : "—"}
      </td>
      <td className="evm-cell evm-cell--num">{priced ? formatForecast(shown.etc) : "—"}</td>
      {/* The sparkline is the PLAN's shape and stays in effort in both units: it
          is drawn from the daily plot, which has no money in it. */}
      <Sparkline row={row} projection={projection} />
    </tr>
  );
}

export function EvmDashboard({
  project,
  projectionRole,
  today,
  baseline,
  revision,
  unplottedLeafCount,
}: EvmDashboardProps): ReactNode {
  const [asOf, setAsOf] = useState(today);
  const [segment, setSegment] = useState<EvmSegment>("task");
  const [unit, setUnit] = useState<EvmUnit>("days");
  const [acknowledged, setAcknowledged] = useState(false);
  // The same fetcher the grid saves through, posting the same command envelope to
  // the same action — publishing is not a special transport, only a special
  // command (Design 0009 §5).
  const publisher = useFetcher<{ ok: boolean; message?: string }>();
  const publishError =
    publisher.data === undefined || publisher.data.ok
      ? null
      : (publisher.data.message ?? "ベースラインを凍結できませんでした");

  const projection = useMemo(
    () => projectEvmDashboard(project, { statusDate: asOf, role: projectionRole }),
    [project, asOf, projectionRole],
  );

  // Schedule variance against the APPROVED plan (Design 0009). Both terms come
  // from the baseline scope — `M_baseline × T_current` — so a task added after
  // publishing cannot flatter SPI by entering EV without entering PV.
  const baselineEvm = useMemo(
    () =>
      baseline === null
        ? null
        : calculateBaselineEvm({
            statusDate: asOf,
            baselineTasks: baseline.tasks.map((task) => ({
              id: task.taskId,
              dailyPlan: task.dailyPlan,
            })),
            progressByTaskId: Object.fromEntries(
              project.tasks.map((task) => [task.id, task.progressBasisPoints]),
            ),
          }),
    [baseline, project.tasks, asOf],
  );
  // Design 0013. Derived on both sides from the same props as the table, so the
  // chart is server-rendered and hydrates to identical SVG.
  const trend = useMemo(
    () =>
      projectEvmTrend(project, {
        statusDate: asOf,
        ...(baseline === null
          ? {}
          : {
              baselineTasks: baseline.tasks.map((task) => ({
                id: task.taskId,
                dailyPlan: task.dailyPlan,
              })),
            }),
      }),
    [project, baseline, asOf],
  );
  const rows =
    segment === "task"
      ? projection.byParentTask
      : segment === "member"
        ? projection.byMember
        : projection.byChange;
  const segmentCaption = SEGMENTS.find((option) => option.key === segment)?.caption ?? "";
  /**
   * The unit is written ONCE, in the header (design 0007 §5 A-3: a unit inside a
   * cell breaks the digit alignment A-1 buys) — so when the unit switches, the
   * header is the only thing that can say so. Found by review: the cells showed
   * 176,000 under a header that still read 人日, which is a header actively
   * lying rather than merely omitting.
   *
   * CPI and SPI keep no unit in either mode; they are ratios.
   */
  const unitLabel = unit === "days" ? "人日" : project.currency;

  return (
    <div className="app-shell">
      <header className="app-header">
        <p className="app-subtitle">
          {project.name ? `${project.name} · ` : ""}EVM · 基準日 {asOf} ·{" "}
          {unit === "days" ? "人日" : "金額"} ·{" "}
          {segmentCaption} {rows.length} 行
        </p>
        <div className="app-header__actions">
          <label className="evm-asof">
            <span className="evm-asof__label">基準日</span>
            <input
              className="evm-asof__input"
              type="date"
              value={asOf}
              data-testid="evm-as-of"
              // An empty value is the browser's "cleared" state, not a date. Keeping
              // the last real one means the table never blanks out mid-edit.
              onChange={(event) => {
                if (event.target.value !== "") setAsOf(event.target.value);
              }}
            />
          </label>
          {/* §5 C-7 — a segmented control, not tabs: the same table with the same
              columns, only the meaning of a row changes, so nothing should suggest
              a move to another page. */}
          {/* Design 0010. Rendered only when a rate actually reached this client:
              `ratedLeafCount` is zero for a general viewer because the projection
              removed the rates, and zero for a project nobody has priced. Either
              way there is nothing to show, so there is no control. */}
          {projection.ratedLeafCount > 0 ? (
            <div className="evm-segment" role="group" aria-label="表示する単位">
              <button
                type="button"
                className={`evm-segment__option${unit === "days" ? " evm-segment__option--on" : ""}`}
                aria-pressed={unit === "days"}
                data-testid="evm-unit-days"
                onClick={() => setUnit("days")}
              >
                人日
              </button>
              <button
                type="button"
                className={`evm-segment__option${unit === "money" ? " evm-segment__option--on" : ""}`}
                aria-pressed={unit === "money"}
                data-testid="evm-unit-money"
                onClick={() => setUnit("money")}
              >
                金額
              </button>
            </div>
          ) : null}
          <div className="evm-segment" role="group" aria-label="集計の単位">
            {SEGMENTS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`evm-segment__option${segment === option.key ? " evm-segment__option--on" : ""}`}
                aria-pressed={segment === option.key}
                data-testid={option.testId}
                onClick={() => setSegment(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Where PV comes from, always — not only when a baseline exists. An
          unlabelled SPI cannot be read: against the approved plan and against a
          plan someone edited this morning are different claims. */}
      <div className="evm-baseline" data-testid="evm-baseline-source">
        {baseline === null ? (
          <p className="evm-baseline__source">
            <b>PV: 現在計画（未凍結・参考値）</b> — ベースラインがまだありません。
            計画を編集すると過去の SV・SPI も変わります。
          </p>
        ) : (
          <p className="evm-baseline__source">
            <b>
              PV: ベースライン v{baseline.version}（公開 {baseline.publishedAt.slice(0, 10)}）
            </b>{" "}
            — SV・SPI はこの承認済み計画に対する差です。
          </p>
        )}
        {baselineEvm === null ? null : (
          <dl className="evm-baseline__metrics" data-testid="evm-baseline-metrics">
            <div>
              <dt>BAC</dt>
              <dd data-testid="baseline-bac">{formatDays(baselineEvm.bac)}</dd>
            </div>
            <div>
              <dt>PV</dt>
              <dd data-testid="baseline-pv">{formatDays(baselineEvm.pv)}</dd>
            </div>
            <div>
              <dt>SV</dt>
              <dd data-testid="baseline-sv">{formatDays(baselineEvm.sv)}</dd>
            </div>
            <div>
              <dt>SPI</dt>
              <dd data-testid="baseline-spi">
                {baselineEvm.spi === "-" ? "—" : baselineEvm.spi.toFixed(2)}
              </dd>
            </div>
          </dl>
        )}
        <div className="evm-baseline__publish">
          {/* The count is rendered BEFORE the checkbox that waives it. The gate is
              only meaningful if the number was in front of the person who ticked
              it — a checkbox with nothing beside it is a formality. */}
          {unplottedLeafCount > 0 ? (
            <label className="evm-baseline__ack">
              <input
                type="checkbox"
                data-testid="evm-acknowledge-unplotted"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span data-testid="evm-unplotted-count">
                日次計画が見積りと合わない末端タスクが {unplottedLeafCount} 件あります。
                そのまま凍結すると、その分の予算は 0 として固定されます。
              </span>
            </label>
          ) : null}
          <button
            type="button"
            className="evm-baseline__button"
            data-testid="evm-publish-baseline"
            disabled={publisher.state !== "idle"}
            onClick={() => {
              // `void`, not `await`: the fetcher owns the lifecycle and re-renders
              // with its own state; awaiting here would only hold the handler open.
              // Marked explicitly because `no-floating-promises` is one of the
              // rules this repo keeps for the authorization case it also catches.
              void publisher.submit(
                {
                  expectedRevision: revision,
                  commands: [
                    {
                      command: acknowledged
                        ? { type: "baseline.publish", acknowledgeUnplottedTasks: true }
                        : { type: "baseline.publish" },
                      // Client-minted, and unique per attempt. The batch schema
                      // requires it, and it is what makes a double-click one
                      // publish rather than two — a duplicate key replays the
                      // first receipt instead of executing again.
                      idempotencyKey: `baseline-publish-${revision}-${
                        acknowledged ? "ack" : "plain"
                      }`,
                    },
                  ],
                },
                { method: "post", encType: "application/json" },
              );
            }}
          >
            {publisher.state === "idle" ? "現在の計画をベースラインとして凍結" : "凍結中…"}
          </button>
          {publishError === null ? null : (
            <p className="evm-baseline__error" role="alert" data-testid="evm-publish-error">
              {publishError}
            </p>
          )}
        </div>
      </div>

      <section className="evm-trend" data-testid="evm-trend">
        <div className="evm-trend__head">
          <h2 className="evm-trend__title">推移（人日・累積）</h2>
          <ul className="evm-trend__legend">
            <li className="evm-trend__key evm-trend__key--pv">
              PV{trend.pvSource === "baseline" ? "（ベースライン）" : "（現在計画）"}
            </li>
            <li className="evm-trend__key evm-trend__key--ac">AC（日付つき実績）</li>
            <li className="evm-trend__key evm-trend__key--ev">EV（基準日の 1 点）</li>
          </ul>
        </div>
        <EvmTrendChart trend={trend} />
        {/* EV is a point and not a line, and the reason has to be on the screen:
            a missing line reads as a bug unless it is named as a limit. */}
        <p className="evm-trend__note">
          EV は<b>線になりません</b>。進捗は現在値だけを保持していて履歴が無いため、
          基準日の 1 点として描いています。
          {trend.undatedActualDays > 0 ? (
            <>
              {" "}
              また AC の曲線には<b>日付つきの実績だけ</b>が入ります。日付の無い実績{" "}
              <b data-testid="evm-trend-undated">{formatDays(trend.undatedActualDays)}</b>{" "}
              人日は、下の表の AC には含まれますが曲線には現れません（いつ使ったかが分からないため）。
            </>
          ) : null}
        </p>
      </section>

      {unit === "money" ? (
        <p className="evm-note" data-testid="evm-money-note">
          金額は<b>単価 × 工数</b>の導出値で、どこにも保存していません（単位は
          {project.currency} の最小単位）。
          {projection.unratedLeafCount > 0 ? (
            <>
              {" "}
              単価の分からない末端タスクが{" "}
              <b data-testid="evm-unrated-count">{projection.unratedLeafCount}</b>{" "}
              件あり、<b>金額の集計から外しています</b>（0 円として足すと、
              費用が少なく出たことが画面から読めなくなるため）。
            </>
          ) : null}
        </p>
      ) : null}

      {/* Says plainly what the as-of date does. Without it an earlier date reads
          as a historical snapshot, and it is not one: only PV is recomputed. */}
      <p className="evm-note">
        基準日で変わるのは PV（と、そこから出る SV・SPI）だけです。EV と AC
        は現在の進捗・実績をそのまま使います（タスクごとに保持しているのは現在の進捗 1
        つで、履歴ではないため）。数値はすべて工数（人日）です。
      </p>

      <div className="evm-scroll">
        <table className="evm-table" aria-label="EVM 集計">
          <thead>
            <tr>
              <th scope="col" className="evm-head evm-head--name">
                {segmentCaption}
              </th>
              {/* §5 A-3 — the unit is written once, here, and never in a cell:
                  a unit inside a cell breaks the digit alignment A-1 buys. */}
              {DAY_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`evm-head evm-head--num evm-head--band-${column.band}`}
                >
                  {column.label}
                  <span className="evm-head__unit">{unitLabel}</span>
                </th>
              ))}
              <th scope="col" className="evm-head evm-head--num evm-head--group">
                SV<span className="evm-head__unit">{unitLabel}</span>
              </th>
              <th scope="col" className="evm-head evm-head--num">
                CV<span className="evm-head__unit">{unitLabel}</span>
              </th>
              <th scope="col" className="evm-head evm-head--num">
                CPI
              </th>
              <th scope="col" className="evm-head evm-head--num">
                SPI
              </th>
              <th scope="col" className="evm-head evm-head--num evm-head--group">
                EAC<span className="evm-head__unit">{unitLabel}</span>
              </th>
              <th scope="col" className="evm-head evm-head--num">
                ETC<span className="evm-head__unit">{unitLabel}</span>
              </th>
              <th scope="col" className="evm-head evm-head--curve">
                推移
              </th>
            </tr>
          </thead>
          <tbody>
            {/* §5 A-2 — the project total stays pinned under the header, so a row
                far down the table can always be read against the whole. */}
            <MetricRow
              row={projection.total}
              projection={projection}
              caption="プロジェクト合計"
              unit={unit}
            />
            {rows.map((row) => (
              <MetricRow
                key={row.key}
                row={row}
                projection={projection}
                caption={row.kind === "unassigned" ? "未割当" : row.label}
                unit={unit}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
