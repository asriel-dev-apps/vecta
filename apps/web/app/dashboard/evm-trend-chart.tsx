import { type ReactNode } from "react";
import type { EvmTrendPoint, EvmTrendSeries } from "@vecta/application";

/**
 * The project's EVM trend (Design 0013): cumulative PV, cumulative AC, and EV as
 * a single point at the as-of date.
 *
 * **There is no EV line and this component will not grow one.** EV over time
 * needs a progress history, and the product has none — the timesheet import
 * carries effort, not progress (Design 0011 §2). A drawn EV curve would be
 * invention that looks exactly like measurement, which is the one failure mode a
 * chart makes invisible. The single point is what is actually known.
 *
 * Everything here is derived from the props, so the server and the client emit
 * byte-identical SVG. No `Date.now()`, no locale formatting, no measurement of
 * the DOM — the same discipline the WBS grid uses to stay isomorphic.
 */

const WIDTH = 720;
const HEIGHT = 200;
const PADDING = { top: 12, right: 12, bottom: 22, left: 44 };
const MS_PER_DAY = 86_400_000;

function dayIndex(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / MS_PER_DAY);
}

/** One decimal, matching the table's person-day columns so the axis and the cells agree. */
function formatDays(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1);
}

export function EvmTrendChart({ trend }: { readonly trend: EvmTrendSeries }): ReactNode {
  const { pv, ac, ev, statusDate, start, end } = trend;
  if (start === null || end === null) {
    return (
      <p className="evm-trend__empty" data-testid="evm-trend-empty">
        日次計画も日付つき実績もまだありません。
      </p>
    );
  }

  const firstDay = dayIndex(start);
  const span = Math.max(1, dayIndex(end) - firstDay);
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const peak = Math.max(
    pv.at(-1)?.value ?? 0,
    ac.at(-1)?.value ?? 0,
    ev,
    // A non-zero ceiling, so a project with nothing yet does not divide by zero
    // and does not draw everything on the top edge.
    0.1,
  );

  const x = (date: string): number =>
    PADDING.left + (Math.max(0, Math.min(span, dayIndex(date) - firstDay)) / span) * plotWidth;
  const y = (value: number): number =>
    PADDING.top + plotHeight - (Math.max(0, Math.min(peak, value)) / peak) * plotHeight;

  /**
   * A cumulative series starts at zero the day BEFORE its first point, so the
   * first step reads as a rise rather than as a value that was always there.
   */
  const path = (points: readonly EvmTrendPoint[]): string => {
    const first = points[0];
    if (first === undefined) return "";
    const lead = `${x(start) === x(first.date) ? PADDING.left : x(first.date)},${y(0)}`;
    return [lead, ...points.map((point) => `${x(point.date)},${y(point.value)}`)].join(" ");
  };

  const asOfX = x(statusDate);
  const gridValues = [0, peak / 2, peak];

  return (
    <svg
      className="evm-trend__svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      // The numbers themselves are read out by the legend and the table below, so
      // the label describes what the picture adds: the shape and the gap.
      aria-label={`EVM 推移。計画値と実績の累積、基準日 ${statusDate} 時点の出来高。`}
      data-testid="evm-trend-chart"
    >
      {gridValues.map((value) => (
        <g key={value}>
          <line
            className="evm-trend__grid"
            x1={PADDING.left}
            y1={y(value)}
            x2={WIDTH - PADDING.right}
            y2={y(value)}
          />
          <text className="evm-trend__tick" x={PADDING.left - 6} y={y(value) + 3} textAnchor="end">
            {formatDays(value)}
          </text>
        </g>
      ))}

      <line
        className="evm-trend__asof"
        x1={asOfX}
        y1={PADDING.top}
        x2={asOfX}
        y2={PADDING.top + plotHeight}
      />

      {pv.length === 0 ? null : (
        <polyline className="evm-trend__pv" points={path(pv)} data-testid="evm-trend-pv" />
      )}
      {ac.length === 0 ? null : (
        <polyline className="evm-trend__ac" points={path(ac)} data-testid="evm-trend-ac" />
      )}
      <circle
        className="evm-trend__ev"
        cx={asOfX}
        cy={y(ev)}
        r={3.5}
        data-testid="evm-trend-ev"
      />

      <text className="evm-trend__tick" x={PADDING.left} y={HEIGHT - 6}>
        {start}
      </text>
      <text className="evm-trend__tick" x={WIDTH - PADDING.right} y={HEIGHT - 6} textAnchor="end">
        {end}
      </text>
    </svg>
  );
}
