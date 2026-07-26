#!/usr/bin/env node
// Deploy the staging Worker (ADR 0014). Run from the repo root:
//
//   pnpm deploy:staging            build, guard, deploy, verify the gate
//   pnpm deploy:staging --fast     skip `pnpm check` (the build still runs)
//
// This path exists so an agent can put a change in front of a browser without a
// human approving anything. Production is untouched by it: `deploy.yml` and its
// approval gate remain the only way to reach production.
//
// Everything mutable is written into `build/`, which is gitignored. The tracked
// `wrangler.jsonc` is never edited — a tracked file holding a deployment value is
// one mistimed commit away from being permanent.

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const WORKER_NAME = "vecta-staging";
const PRODUCTION_WORKER_NAME = "vecta";
const CONFIG_PATH = "apps/web/build/server/wrangler.json";
const KEY_KEYCHAIN_SERVICE = "vecta-staging-access-key";

/** Distinct from production's 2001–2003 so the two never share a limiter namespace. */
const RATE_LIMIT_NAMESPACES = {
  PRE_AUTH_RATE_LIMIT: "3001",
  AUTH_RATE_LIMIT: "3002",
  COMPUTE_RATE_LIMIT: "3003",
};

const fast = process.argv.includes("--fast");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${String(result.status)}`);
  }
}

/** Read a Keychain secret WITHOUT letting it reach stdout or an argv of ours. */
function keychainSecret(service) {
  const result = spawnSync("security", ["find-generic-password", "-w", "-s", service], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length === 0 ? null : value;
}

function step(message) {
  console.log(`\n── ${message}`);
}

async function materialiseStagingConfig() {
  const configPath = path.resolve(CONFIG_PATH);
  const config = JSON.parse(await readFile(configPath, "utf8"));

  // The same trap the production runbook names: a config without `assets.directory`
  // deploys a Worker that keeps serving the previous bundle.
  if (typeof config.assets?.directory !== "string" || config.assets.directory.length === 0) {
    throw new Error(`${CONFIG_PATH} has no assets.directory — the deploy would serve stale assets`);
  }

  config.name = WORKER_NAME;
  // Arms the gate. Without this the Worker would be a public copy of the app.
  config.vars = { ...config.vars, DEPLOY_ENV: "staging" };

  if (!Array.isArray(config.ratelimits) || config.ratelimits.length !== 3) {
    throw new Error(`${CONFIG_PATH} must carry three rate-limit bindings`);
  }
  for (const binding of config.ratelimits) {
    const namespace = RATE_LIMIT_NAMESPACES[binding.name];
    if (namespace === undefined) throw new Error(`Unexpected rate-limit binding ${binding.name}`);
    binding.namespace_id = namespace;
  }

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

/**
 * The guards. An agent can run this script unattended, so the ways it could damage
 * production are the ways that matter — and each is refused rather than warned about.
 */
function guard(config) {
  if (config.name !== WORKER_NAME) {
    throw new Error(`Refusing to deploy: worker name is "${config.name}", expected "${WORKER_NAME}"`);
  }
  if (config.name === PRODUCTION_WORKER_NAME) {
    throw new Error("Refusing to deploy: this is the PRODUCTION worker name");
  }
  if (config.vars?.DEPLOY_ENV !== "staging") {
    throw new Error("Refusing to deploy: DEPLOY_ENV is not \"staging\", so the gate would be inert");
  }

  // The staging DB must not be production's. Compared by HOST only, and neither
  // value is printed — the same shape as `migrate.mjs`'s EXPECTED_DATABASE_HOST guard.
  const staging = keychainSecret("vecta-staging-database-url");
  const production = keychainSecret("vecta-database-url");
  if (staging !== null && production === null) {
    // A comparison with a missing input is silent, and silence here reads exactly
    // like a pass. Non-blocking: a machine with no production credential is the
    // safer machine, not the riskier one.
    console.warn(
      '\nNOT CHECKED: Keychain has no "vecta-database-url", so the staging DATABASE_URL was ' +
        "not compared against production. Confirm by hand that it names the staging Neon branch.",
    );
  }
  if (staging !== null && production !== null) {
    const hostOf = (url) => {
      try {
        return new URL(url).host;
      } catch {
        return null;
      }
    };
    const stagingHost = hostOf(staging);
    const productionHost = hostOf(production);
    if (stagingHost !== null && stagingHost === productionHost) {
      throw new Error(
        "Refusing to deploy: the staging DATABASE_URL points at the PRODUCTION database host. " +
          "Staging must have its own Neon branch (ADR 0014).",
      );
    }
  }
}

/**
 * Prove the gate is live, from outside, before calling the deploy a success.
 *
 * Both directions, because a check that only confirms admission cannot tell a
 * working gate from an absent one — and an absent gate is the failure that matters.
 */
async function verifyGate(origin, key) {
  // A freshly created `workers.dev` route answers 404 for a few seconds before it is
  // live. Retry ONLY on that, and only for a bounded window: anything that looks
  // like the app answering is a hard failure immediately, because "wait and see"
  // must never be able to turn "the gate is not enforced" into a pass.
  let anonymous = await fetch(`${origin}/login`, { redirect: "manual" });
  for (let attempt = 0; anonymous.status === 404 && attempt < 10; attempt += 1) {
    await sleep(3_000);
    anonymous = await fetch(`${origin}/login`, { redirect: "manual" });
  }
  if (anonymous.status === 404) {
    throw new Error(
      `${origin}/login still answers 404 after 30s. The route did not come up; the deploy is not verified.`,
    );
  }
  if (anonymous.status !== 403) {
    throw new Error(
      `GATE NOT ENFORCED: an anonymous request to ${origin}/login returned ${anonymous.status}, expected 403. ` +
        "The environment may be publicly reachable right now.",
    );
  }

  if (key === null) {
    console.log(
      "  anonymous: 403 (good). Keyed check SKIPPED — no key in Keychain, so this deploy is " +
        "unreachable by anyone including you. Set it, then re-run.",
    );
    return;
  }

  const keyed = await fetch(`${origin}/login`, { headers: { "x-staging-key": key } });

  // Two DIFFERENT failures live here and must not share a message. A 403 means the
  // key is wrong — the gate did its job. Anything else non-OK means the gate let the
  // request through and the APP could not answer, which is a completely different
  // thing to go and fix. Reporting the second as "the key was refused" sends the
  // reader to the wrong place entirely.
  if (keyed.status === 403) {
    throw new Error(
      "The key was refused. The Worker secret STAGING_ACCESS_KEY is absent or differs from the " +
        "Keychain value — run `pnpm staging:secrets`.",
    );
  }
  if (!keyed.ok) {
    throw new Error(
      `The gate is enforced correctly (anonymous 403, the key gets through), but the app answered ` +
        `${keyed.status}. Staging is NOT usable yet.\n` +
        "  The usual cause is a missing DATABASE_URL: `createDbSession` validates it eagerly for every\n" +
        "  request, so without it every path past the gate is a 500. Create the staging Neon branch,\n" +
        "  put its connection string in Keychain as `vecta-staging-database-url`, then run\n" +
        "  `pnpm staging:secrets` (ADR 0014 未決事項 1).",
    );
  }
  const body = await keyed.text();
  if (!body.includes("google-sign-in")) {
    throw new Error("The keyed request succeeded but did not return the application's login screen.");
  }
  console.log("  anonymous: 403  ·  keyed: 200 and the app rendered  ✓");
}

async function main() {
  if (!fast) {
    step("pnpm check");
    run("pnpm", ["check"]);
  } else {
    step("pnpm check SKIPPED (--fast)");
  }

  step("build");
  run("pnpm", ["--dir", "apps/web", "build"]);

  step("materialise the staging config (into build/, never the tracked file)");
  const config = await materialiseStagingConfig();

  step("guards");
  guard(config);
  console.log(`  worker=${config.name}  DEPLOY_ENV=${config.vars.DEPLOY_ENV}  ✓`);

  step("deploy");
  run("npx", ["wrangler", "deploy", "-c", CONFIG_PATH]);

  step("verify the gate from outside");
  const origin = process.env.STAGING_ORIGIN ?? `https://${WORKER_NAME}.tt-dev.workers.dev`;
  await verifyGate(origin, keychainSecret(KEY_KEYCHAIN_SERVICE));

  console.log(`\nstaging is live at ${origin} and refuses anyone without the key.`);
}

await main();
