#!/usr/bin/env node
// Put the staging Worker's secrets in place from the macOS Keychain (ADR 0014):
//
//   pnpm staging:secrets
//
// Values are piped straight from Keychain into `wrangler secret put` and are never
// printed, never written to a file, and never placed in an argv this process owns.
//
// It generates STAGING_ACCESS_KEY on first run if the Keychain has none, because a
// staging deploy without one refuses every request — including yours. To read the
// key when you need it in a browser, run it yourself:
//
//   security find-generic-password -w -s vecta-staging-access-key
//
// Then open https://vecta-staging.tt-dev.workers.dev/ and paste it into the form on
// the refusal page — ONCE, after which a cookie carries it. The key deliberately has
// no URL form: a query string is written verbatim into Cloudflare's request logs,
// shows in the address bar, persists in history, and travels in a Referer.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";

const WORKER_NAME = "vecta-staging";

const SECRETS = [
  {
    binding: "STAGING_ACCESS_KEY",
    service: "vecta-staging-access-key",
    generate: true,
    why: "the gate's shared key; without it staging refuses everyone",
  },
  {
    binding: "SESSION_SECRET",
    service: "vecta-staging-session-secret",
    generate: true,
    why: "signs staging session cookies; MUST differ from production's",
  },
  {
    binding: "DATABASE_URL",
    service: "vecta-staging-database-url",
    generate: false,
    why: "the staging Neon branch (you create it; see ADR 0014 未決事項 1)",
  },
  {
    binding: "OIDC_CLIENT_SECRET",
    service: "vecta-staging-oidc-client-secret",
    generate: false,
    why: "only needed if YOU want to sign in with Google on staging; agents mint a session cookie instead",
  },
];

function keychainRead(service) {
  const result = spawnSync("security", ["find-generic-password", "-w", "-s", service], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length === 0 ? null : value;
}

/**
 * Store a value in Keychain, then READ IT BACK and check it.
 *
 * The read-back is not belt-and-braces, it is the whole point: `security
 * add-generic-password -w` with the value on stdin exits 0 and stores an EMPTY
 * password. That silently produced a staging Worker holding a random key that
 * existed nowhere else — nobody could get in, and because every request was
 * refused it looked exactly like a correctly working gate.
 *
 * The value goes in argv, which is visible to other processes on this machine for
 * the few milliseconds the call takes. That is a real (small, local) exposure,
 * accepted because the alternative silently loses the secret.
 */
function keychainWrite(service, value) {
  const result = spawnSync(
    "security",
    ["add-generic-password", "-U", "-a", process.env.USER ?? "vecta", "-s", service, "-w", value],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Could not store ${service} in Keychain: ${result.stderr.trim()}`);
  }
  const readBack = keychainRead(service);
  if (readBack !== value) {
    throw new Error(
      `Keychain did not store ${service} correctly: what came back is ` +
        `${readBack === null ? "absent" : `${String(readBack.length)} characters, expected ${String(value.length)}`}. ` +
        "Refusing to continue — a secret that cannot be read back is a secret that is lost.",
    );
  }
}

function randomKey() {
  return randomBytes(32).toString("hex");
}

function putSecret(binding, value) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", binding, "--name", WORKER_NAME], {
    input: value,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`wrangler secret put ${binding} failed: ${result.stderr.trim()}`);
  }
}

const missing = [];
for (const secret of SECRETS) {
  let value = keychainRead(secret.service);

  if (value === null && secret.generate) {
    value = randomKey();
    keychainWrite(secret.service, value);
    console.log(`  ${secret.binding}: generated and stored in Keychain as "${secret.service}"`);
  }

  if (value === null) {
    missing.push(secret);
    console.log(`  ${secret.binding}: SKIPPED — no Keychain item "${secret.service}" (${secret.why})`);
    continue;
  }

  putSecret(secret.binding, value);
  console.log(`  ${secret.binding}: set on ${WORKER_NAME}`);
}

// A production DATABASE_URL reaching staging is the one mistake here that could
// damage real data, so it is refused rather than warned about.
const staging = keychainRead("vecta-staging-database-url");
const production = keychainRead("vecta-database-url");
if (staging !== null && production !== null) {
  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  };
  if (hostOf(staging) !== null && hostOf(staging) === hostOf(production)) {
    console.error(
      "\nERROR: the staging DATABASE_URL points at the PRODUCTION database host. " +
        "Staging needs its own Neon branch (ADR 0014). Nothing about the database was changed on production, " +
        "but fix this before using staging.",
    );
    process.exitCode = 1;
  }
}

if (missing.length > 0) {
  console.log(
    `\n${missing.length} secret(s) not set. Staging will still deploy and the gate will still hold; ` +
      "the app will fail on anything needing them.",
  );
}
