// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { App as WbsApp } from "~/wbs/wbs-app";
import { buildPerfFixture } from "../perf/fixture";
import { addDays, V_LEFT } from "../perf/geometry";

// 300 rows x 500 day columns: far larger than the virtual window (720px / 30px
// rows + overscan, 1440px / 48px columns + overscan), small enough for `pnpm check`.
// happy-dom does no layout, so the sizes the virtualizers read are shimmed for
// this file only and restored afterwards. Scale (5,000 rows) and real layout are
// covered by the browser spec (`pnpm e2e:grid`); nothing here is a timing check.
const originals: { height?: PropertyDescriptor | undefined; width?: PropertyDescriptor | undefined; observer?: unknown } = {};
beforeAll(() => {
  originals.height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  originals.width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  originals.observer = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 720 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1440 });
});
afterAll(() => {
  if (originals.height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originals.height);
  else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
  if (originals.width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originals.width);
  else Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  globalThis.ResizeObserver = originals.observer as typeof ResizeObserver;
});
afterEach(cleanup);

const { project } = buildPerfFixture(300, 500);
const tasks = project.tasks;
const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

function mount(): HTMLElement {
  render(<WbsApp initialState={project} initialRevision="1" projectionRole="PRIVILEGED" />);
  return screen.getByTestId("wbs-grid");
}
async function scrollTo(grid: HTMLElement, top: number, left: number): Promise<void> {
  grid.scrollTop = top;
  grid.scrollLeft = left;
  fireEvent.scroll(grid);
  await waitFor(() => expect(grid.scrollTop).toBe(top));
}
const rowIds = (grid: HTMLElement) => [...grid.querySelectorAll("[data-row-id]")].map((row) => row.getAttribute("data-row-id"));
const nameOf = (grid: HTMLElement, index: number) =>
  grid.querySelector(`[data-row-id="${tasks[index]!.id}"] [data-col="name"]`)?.textContent ?? null;

describe("grid windowing follows the scroll offset", () => {
  it("renders the first screen only, then the rows at the scrolled offset", async () => {
    const grid = mount();
    expect(nameOf(grid, 0) ?? "row 0 is not rendered").toContain("Phase A deliverable 1");
    expect(nameOf(grid, 299)).toBeNull();
    expect(rowIds(grid).length).toBeLessThan(80);

    await scrollTo(grid, 150 * 30, 0);
    await waitFor(() => expect(nameOf(grid, 150) ?? "row 150 is not rendered").toContain(tasks[150]!.name));
    expect(tasks[150]!.name).toBe("Phase Z deliverable 26");
    expect(nameOf(grid, 0)).toBeNull();
    expect(rowIds(grid).length).toBeLessThan(80);
  });

  it("renders the day columns at the scrolled offset and drops the old ones", async () => {
    const grid = mount();
    await scrollTo(grid, 0, V_LEFT);
    const cell = (row: number, col: number) =>
      grid.querySelector(`[data-row-id="${tasks[row]!.id}"] [data-daily-date="${addDays("2026-01-05", col)}"] .daily-cell-value`);
    const stamped = tasks[1]!.dailyPlan[addDays("2026-01-05", 9)]!;
    expect(stamped).toBeGreaterThan(0);
    await waitFor(() => expect(cell(1, 9)?.textContent).toBe(fmt(stamped / 60)));

    await scrollTo(grid, 0, V_LEFT + 380 * 48);
    const farDate = addDays("2026-01-05", 380 + 9);
    await waitFor(() => expect(grid.querySelector(`.head-cell--day[title="${farDate}"]`)?.textContent).toBe(farDate.slice(8)));
    expect(grid.querySelector('.head-cell--day[title="2026-01-05"]')).toBeNull();
    expect(cell(1, 9)).toBeNull();
  });
});

describe("a day-cell edit moves BAC by the literal amount", () => {
  it("2 h -> 20 h on one leaf adds 18 h = 2.25 person-days to BAC", async () => {
    let minutes = 0;
    for (const task of tasks) for (const value of Object.values(task.dailyPlan)) minutes += value;
    const bacBefore = fmt(minutes / 480);

    const grid = mount();
    await scrollTo(grid, 0, V_LEFT);
    const date = addDays("2026-01-05", 9);
    const row = tasks[1]!;
    const before = row.dailyPlan[date]!;
    const expectedAfter = fmt((minutes - before + 20 * 60) / 480);
    const bac = () =>
      [...screen.getByTestId("rollup").querySelectorAll(".rollup-metric")]
        .find((metric) => metric.querySelector(".rollup-metric-label")?.textContent?.includes("BAC"))
        ?.querySelector(".rollup-metric-value")?.textContent;
    expect(bac()).toBe(bacBefore);

    const cell = await waitFor(() => {
      const found = grid.querySelector<HTMLElement>(`[data-daily-row="${row.id}"][data-daily-date="${date}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    fireEvent.doubleClick(cell);
    const editor = cell.querySelector("input.daily-cell-editor") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "20" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(bac()).toBe(expectedAfter));
    expect(cell.querySelector(".daily-cell-value")?.textContent).toBe("20");
    expect(bac()).not.toBe(bacBefore);
  });
});
