import { createRoot } from "react-dom/client";
import { App } from "../app/wbs/wbs-app";
import "../app/wbs/styles.css";
import { installDriver, type PerfApi } from "./driver";
import { buildPerfFixture, FIXTURE_ID } from "./fixture";

declare global {
  interface Window {
    __PERF__?: PerfApi;
    __perfBootMs?: number;
  }
}

const params = new URLSearchParams(location.search);
const rows = Number(params.get("n") ?? "5000");
const cols = Number(params.get("cols") ?? "45");
const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

const bootMs = performance.now();
const fixture = buildPerfFixture(rows, cols);
const renderStartMs = performance.now();
window.__PERF__ = installDriver(fixture, { fixtureId: FIXTURE_ID, bootMs, renderStartMs });
createRoot(root).render(
  <div className="app-frame">
    <App initialState={fixture.project} initialRevision="1" projectionRole="PRIVILEGED" />
  </div>,
);
