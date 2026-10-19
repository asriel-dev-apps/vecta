/* global window, document, requestAnimationFrame, setTimeout -- page.evaluate callbacks run in the browser */
// Perf gate for the WBS grid (design 0016 §5 #1). Production build of the real
// WbsApp, headless Chrome, 1440x900.
//   pnpm perf -- --label=before                  (45 and 500 columns, 5 runs)
//   pnpm perf -- --label=after --compare=perf/results/before.json
//   options: --cols=45,500  --runs=5  --only=V500,H500  --no-build
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { BASE, PORT, assertServerIdentity, openPerfPage, runEdit } from "./drive.mjs";
import { SCENARIOS, evaluate, median, workGate, workStats } from "./gate.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(dir, "..");

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const label = arg("label", "run");
const runs = Number(arg("runs", "5"));
const colsList = arg("cols", "45,500").split(",").map(Number);
const only = arg("only", "");
const compare = arg("compare", "");
const noBuild = process.argv.includes("--no-build");
const ids = Object.keys(SCENARIOS).filter((id) => colsList.includes(SCENARIOS[id].cols) && (only === "" || only.split(",").includes(id)));

if (!noBuild) {
  const build = spawnSync("pnpm", ["exec", "vite", "build", "--config", "perf/vite.config.ts", "--logLevel", "warn"], { cwd: webDir, stdio: "inherit" });
  if (build.status !== 0) throw new Error("perf build failed");
}

fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
const log = fs.createWriteStream(path.join(dir, "dist", "preview.log"));
const server = spawn(
  "pnpm",
  ["exec", "vite", "preview", "--config", "perf/vite.config.ts", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
  { cwd: webDir, stdio: ["ignore", "pipe", "pipe"] },
);
server.stdout.pipe(log);
server.stderr.pipe(log);

async function waitForIdentity() {
  const deadline = Date.now() + 30_000;
  let last = "";
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`vite preview exited ${server.exitCode} (port ${PORT} in use?): see perf/dist/preview.log`);
    try {
      await assertServerIdentity(BASE);
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`perf server did not come up: ${last}`);
}

async function launch() {
  for (const options of [{ channel: "chrome", headless: true }, { headless: true }]) {
    try {
      return await chromium.launch(options);
    } catch {
      // try the next channel
    }
  }
  throw new Error("no browser could be launched");
}

let exitCode = 0;
try {
  await waitForIdentity();
  const browser = await launch();
  const doc = {
    label,
    recordedAt: new Date().toISOString(),
    machine: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? "unknown", chrome: browser.version() },
    runs,
    viewport: { width: 1440, height: 900 },
    scenarios: {},
    load: {},
  };
  const newContext = () => browser.newContext({ viewport: { width: 1440, height: 900 } });
  const closeAll = async (context) => context.close();

  const load = () => Number(os.loadavg()[0].toFixed(2));
  doc.loadavgStart = load();

  // Main-thread work per scroll step = delta of the renderer's cumulative
  // TaskDuration (CDP Performance.getMetrics) across "set scroll + 2 rAF".
  // Idle time, vsync alignment and rAF scheduling do not enter it.
  async function workLane(page, positions, stepTo) {
    const client = await page.context().newCDPSession(page);
    await client.send("Performance.enable");
    const taskSeconds = async () => (await client.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration").value;
    await stepTo(0, 0);
    const stepMs = [];
    for (const position of positions) {
      const before = await taskSeconds();
      await stepTo(position.top, position.left);
      stepMs.push(((await taskSeconds()) - before) * 1000);
    }
    await client.detach();
    return workStats(stepMs);
  }

  // Control: an empty scroller with the grid's scrollable size, driven by the same positions.
  async function controlLane(context, dims, positions) {
    const page = await context.newPage();
    await page.setContent(
      `<div id="s" style="width:${dims.clientWidth}px;height:${dims.clientHeight}px;overflow:auto"><div style="width:${dims.scrollWidth}px;height:${dims.scrollHeight}px"></div></div>`,
    );
    await page.evaluate(() => {
      window.__stepTo = (top, left) => {
        const el = document.getElementById("s");
        el.scrollTop = top;
        el.scrollLeft = left;
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      };
    });
    const stats = await workLane(page, positions, (top, left) => page.evaluate(([t, l]) => window.__stepTo(t, l), [top, left]));
    await page.close();
    return stats;
  }

  for (const id of ids) {
    const { kind, cols } = SCENARIOS[id];
    const work = [];
    const control = [];
    const firstRowMs = [];
    const loadBefore = load();
    for (let run = 0; run < runs; run += 1) {
      const context = await newContext();
      const { page, firstRowMs: first, errors } = await openPerfPage(context, BASE, cols);
      const dims = await page.evaluate(() => window.__PERF__.dims());
      const positions = await page.evaluate((k) => window.__PERF__.positions(k), kind);
      work.push(await workLane(page, positions, (top, left) => page.evaluate(([t, l]) => window.__PERF__.scrollTo(t, l), [top, left])));
      control.push(await controlLane(context, dims, positions));
      firstRowMs.push(first);
      if (errors.length > 0) console.warn(`${id} run ${run}: page errors ${errors.join(" | ")}`);
      await closeAll(context);
    }
    // Frame intervals: informational only (they track vsync and machine load), one run.
    const frameContext = await newContext();
    const framePage = (await openPerfPage(frameContext, BASE, cols)).page;
    const frames = await framePage.evaluate((k) => window.__PERF__.sweep(k), kind);
    await closeAll(frameContext);
    // Untimed correctness pass on a fresh page, same positions, exactly 2 rAF per step.
    const context = await newContext();
    const { page } = await openPerfPage(context, BASE, cols);
    const check = await page.evaluate((k) => window.__PERF__.check(k), kind);
    await closeAll(context);
    const loadAfter = load();
    doc.scenarios[id] = { kind, cols, work, control, frames, loadavg: { before: loadBefore, after: loadAfter }, correctness: check.failures, checked: { ...check, failures: undefined } };
    (doc.load[cols] ??= { firstRowMs: [], editMs: [], editFailures: [] }).firstRowMs.push(...firstRowMs);
    const w = workGate(work).summary;
    const c = workGate(control).summary;
    console.log(
      `${id.padEnd(5)} WORK p95=${w.p95.toFixed(1)}ms max=${w.max.toFixed(1)}ms | CONTROL p95=${c.p95.toFixed(1)}ms max=${c.max.toFixed(1)}ms | frames(info) over50=${frames.framesOver50} p95=${frames.p95FrameMs.toFixed(0)}ms | load ${loadBefore}->${loadAfter} | checked rows=${check.rowsChecked} cells=${check.cellsChecked} nonzero=${check.nonzeroCellsChecked} failures=${check.failures.length}`,
    );
  }

  for (const cols of new Set(ids.map((id) => SCENARIOS[id].cols))) {
    for (let run = 0; run < runs; run += 1) {
      const context = await newContext();
      const { page } = await openPerfPage(context, BASE, cols);
      const edit = await runEdit(page, cols).catch((error) => ({
        ms: -1,
        failures: [`edit probe could not run: ${String(error.message ?? error).split("\n")[0]}`],
      }));
      doc.load[cols].editMs.push(edit.ms);
      if (run === 0) doc.load[cols].editFailures.push(...edit.failures);
      if (edit.ms < 0) doc.load[cols].editFailures.push("edit never reached the expected BAC/hours literals");
      await closeAll(context);
    }
    console.log(`edit@${cols} median ${median(doc.load[cols].editMs).toFixed(0)}ms, firstRow median ${median(doc.load[cols].firstRowMs).toFixed(0)}ms`);
  }
  doc.loadavgEnd = load();
  await browser.close();

  const baseline = compare === "" ? null : JSON.parse(fs.readFileSync(path.resolve(webDir, compare), "utf8"));
  const verdict = evaluate(doc, baseline);
  doc.verdict = verdict;
  fs.mkdirSync(path.join(dir, "results"), { recursive: true });
  const out = path.join(dir, "results", `${label}.json`);
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(webDir, out)}`);
  if (verdict.ok) console.log("GATE: pass");
  else {
    console.log("GATE: FAIL");
    for (const message of verdict.failures) console.log(`  - ${message}`);
    exitCode = 1;
  }
} finally {
  server.kill();
}
process.exit(exitCode);
