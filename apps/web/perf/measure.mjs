/* global window, document, performance, requestAnimationFrame, setTimeout -- page.evaluate callbacks run in the browser */
// Perf gate for the WBS grid (design 0016 §5 #1). Production build of the real
// WbsApp, headless Chrome, 1440x900. The candidate (this checkout) and the
// before build (a second checkout) are measured interleaved in ONE session.
//   pnpm perf -- --before-dir=/path/to/before/apps/web --before-port=4188 --port=4187
//   --only=W500,V500   partial run: diagnostic, never "pass"
//   --no-before        candidate only: diagnostic (also how a single build is probed)
//   --runs=5  --no-build  --label=run
//   proof hooks (one-time harness proofs, see the decisions file):
//   --sabotage=blank|no-mouse|control-direct|smooth|busy:<ms>
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertServerIdentity, launchBrowser, openControlPage, openPerfPage, runEdit, taskTimer, wheelRun } from "./drive.mjs";
import { LANES, LOAD_COLS, evaluate, median, workGate, workStats } from "./gate.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(dir, "..");

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const label = arg("label", "run");
const runs = Number(arg("runs", "5"));
const only = arg("only", "");
const port = Number(arg("port", "4177"));
const beforePort = Number(arg("before-port", "4178"));
const beforeDir = arg("before-dir", "");
const sabotage = arg("sabotage", "");
const noBuild = process.argv.includes("--no-build");
const withBefore = beforeDir !== "" && !process.argv.includes("--no-before");
const diagnostic = only !== "" || !withBefore;
const ids = Object.keys(LANES).filter((id) => only === "" || only.split(",").includes(id));

const targets = { C: { cwd: webDir, port, base: `http://127.0.0.1:${port}` } };
if (withBefore) targets.B = { cwd: path.resolve(beforeDir), port: beforePort, base: `http://127.0.0.1:${beforePort}` };

const servers = [];
const stopServers = () => {
  for (const server of servers) {
    try {
      process.kill(-server.pid);
    } catch {
      // already gone
    }
  }
};

for (const target of Object.values(targets)) {
  if (!noBuild) {
    const build = spawnSync("pnpm", ["exec", "vite", "build", "--config", "perf/vite.config.ts", "--logLevel", "warn"], { cwd: target.cwd, stdio: "inherit" });
    if (build.status !== 0) throw new Error(`perf build failed in ${target.cwd}`);
  }
}

let exitCode = 0;
try {
  for (const target of Object.values(targets)) {
    fs.mkdirSync(path.join(target.cwd, "perf", "dist"), { recursive: true });
    const log = fs.createWriteStream(path.join(target.cwd, "perf", "dist", "preview.log"));
    const server = spawn(
      "pnpm",
      ["exec", "vite", "preview", "--config", "perf/vite.config.ts", "--port", String(target.port), "--strictPort", "--host", "127.0.0.1"],
      { cwd: target.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    server.stdout.pipe(log);
    server.stderr.pipe(log);
    servers.push(server);
    const deadline = Date.now() + 30_000;
    for (let last = ""; target.build === undefined; ) {
      if (server.exitCode !== null) throw new Error(`vite preview exited ${server.exitCode} (port ${target.port} in use?): see ${target.cwd}/perf/dist/preview.log`);
      if (Date.now() > deadline) throw new Error(`perf server did not come up: ${last}`);
      try {
        target.build = await assertServerIdentity(target.base);
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  if (withBefore && targets.B.build === targets.C.build) {
    throw new Error(`server identity: both servers serve the same build (${targets.C.build.slice(0, 12)}): refusing to measure`);
  }

  const browser = await launchBrowser({ smooth: sabotage === "smooth" });
  const doc = {
    label,
    recordedAt: new Date().toISOString(),
    machine: { os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? "unknown", chrome: browser.version() },
    runs,
    viewport: { width: 1440, height: 900 },
    builds: { candidate: targets.C.build, before: targets.B?.build },
    order: [],
    scenarios: {},
  };
  const newContext = () => browser.newContext({ viewport: { width: 1440, height: 900 } });
  const busyMs = sabotage.startsWith("busy:") ? Number(sabotage.slice(5)) : 0;

  async function jumpRun(context, page, kind, dims) {
    const positions = await page.evaluate((k) => window.__PERF__.positions(k), kind);
    const lane = async (target, stepTo) => {
      const timer = await taskTimer(target);
      await stepTo(0, 0);
      const stepMs = [];
      for (const position of positions) {
        const before = await timer.now();
        await stepTo(position.top, position.left);
        stepMs.push((await timer.now()) - before);
      }
      await timer.detach();
      return workStats(stepMs);
    };
    const work = await lane(page, (top, left) => page.evaluate(([t, l]) => window.__PERF__.scrollTo(t, l), [top, left]));
    const control = await openControlPage(context, dims);
    await control.evaluate(() => {
      window.__stepTo = (top, left) => {
        const el = document.getElementById("s");
        el.scrollTop = top;
        el.scrollLeft = left;
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      };
    });
    return { work, control: await lane(control, (top, left) => control.evaluate(([t, l]) => window.__stepTo(t, l), [top, left])) };
  }

  async function wheelLane(id, context, page, dims) {
    if (busyMs > 0) {
      await page.evaluate((ms) => window.addEventListener("wheel", () => { const end = performance.now() + ms; while (performance.now() < end); }, { capture: true }), busyMs);
    }
    const sample = ({ stepMs, ...rest }) => ({ ...workStats(stepMs), ...rest });
    const work = sample(await wheelRun(page, id, { move: sabotage !== "no-mouse" }));
    const control = await openControlPage(context, dims);
    return { work, control: sample(await wheelRun(control, id, { selector: "#s", direct: sabotage === "control-direct" })) };
  }

  for (const id of ids) {
    const { cols, kind, wheel } = LANES[id];
    const work = [];
    const control = [];
    for (let run = 0; run < runs; run += 1) {
      const context = await newContext();
      const { page, errors } = await openPerfPage(context, targets.C.base, cols);
      const dims = await page.evaluate(() => window.__PERF__.dims());
      const result = wheel === undefined ? await jumpRun(context, page, kind, dims) : await wheelLane(id, context, page, dims);
      work.push(result.work);
      control.push(result.control);
      if (errors.length > 0) console.warn(`${id} run ${run}: page errors ${errors.join(" | ")}`);
      await context.close();
    }
    // Untimed destination pass on a fresh page. Wheel lanes: the same wheel input,
    // checked passively after every notch. Jump lanes: check() over the same positions.
    const context = await newContext();
    const { page } = await openPerfPage(context, targets.C.base, cols);
    let correctness;
    if (wheel === undefined) correctness = (await page.evaluate((k) => window.__PERF__.check(k), kind)).failures;
    else {
      if (sabotage === "blank") {
        // rendering broken after the page opened: the grid never reacts to scrolling again
        await page.evaluate(() => document.querySelector('[data-testid="wbs-grid"]').addEventListener("scroll", (event) => event.stopImmediatePropagation(), true));
      }
      correctness = (await wheelRun(page, id, { timed: false, observe: true, move: sabotage !== "no-mouse" })).failures;
    }
    await context.close();
    doc.scenarios[id] = { cols, work, control, correctness };
    const w = workGate(work).summary;
    const c = workGate(control).summary;
    console.log(`${id.padEnd(5)} WORK p95=${w.p95.toFixed(1)}ms max=${w.max.toFixed(1)}ms | CONTROL p95=${c.p95.toFixed(1)}ms max=${c.max.toFixed(1)}ms | destination failures=${correctness.length}`);
  }

  if (only === "") {
    // First display and edit at both widths, before and candidate alternating in every round.
    doc.load = {};
    if (withBefore) doc.before = { load: {} };
    for (let run = 0; run < runs; run += 1) {
      for (const cols of LOAD_COLS) {
        for (const side of withBefore ? ["B", "C"] : ["C"]) {
          const entry = ((side === "B" ? doc.before.load : doc.load)[cols] ??= { firstRowMs: [], editMs: [], editFailures: [] });
          const context = await newContext();
          const { page, firstRowMs } = await openPerfPage(context, targets[side].base, cols);
          const edit = await runEdit(page, cols).catch((error) => ({ ms: -1, failures: [`edit probe could not run: ${String(error.message ?? error).split("\n")[0]}`] }));
          entry.firstRowMs.push(firstRowMs);
          entry.editMs.push(edit.ms);
          entry.editFailures.push(...edit.failures);
          if (edit.ms < 0) entry.editFailures.push("edit never reached the expected BAC/hours literals");
          doc.order.push(side);
          await context.close();
        }
      }
    }
    for (const cols of LOAD_COLS) console.log(`@${cols}: firstRow median ${median(doc.load[cols].firstRowMs).toFixed(0)}ms, edit median ${median(doc.load[cols].editMs).toFixed(0)}ms${withBefore ? ` (before ${median(doc.before.load[cols].firstRowMs).toFixed(0)} / ${median(doc.before.load[cols].editMs).toFixed(0)})` : ""}`);
  }
  await browser.close();

  const verdict = evaluate(doc, { diagnostic });
  doc.verdict = verdict;
  fs.mkdirSync(path.join(dir, "results"), { recursive: true });
  const out = path.join(dir, "results", `${label}.json`);
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nwrote ${path.relative(webDir, out)}`);
  if (!verdict.ok) {
    console.log("GATE: FAIL");
    for (const message of verdict.failures) console.log(`  - ${message}`);
    exitCode = 1;
  } else console.log(verdict.diagnostic ? "GATE: diagnostic (not §5 #1)" : "GATE: pass");
} finally {
  stopServers();
}
process.exit(exitCode);
