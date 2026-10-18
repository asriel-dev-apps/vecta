// Hard-coded oracle for the edit probe, from an independent sum over the frozen
// fixture (plain loop over dailyPlan minutes; no App, no EVM code). Reviewed
// literals: if the fixture changes these must be recomputed, and
// test/perf-fixture.test.ts fails until they are.
export const EDIT = {
  rowIndex: 2501,
  col: 10,
  date: "2026-01-15",
  typedHours: "20",
  cellBefore: "2",
  cellAfter: "20",
  // BAC_after = BAC_before + (20 - 2) / 8 person-days
  45: { rowHoursBefore: "17", rowHoursAfter: "35", bacBefore: "21945.5", bacAfter: "21947.8" },
  500: { rowHoursBefore: "46", rowHoursAfter: "64", bacBefore: "28116.5", bacAfter: "28118.8" },
};
