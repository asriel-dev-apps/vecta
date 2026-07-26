#!/usr/bin/env node
// Which security SURFACES does a change touch? (VECTA, 2026-07-26)
//
//   node .github/scripts/security-surfaces.mjs                  staged changes
//   node .github/scripts/security-surfaces.mjs --range A..B      a commit range
//   node .github/scripts/security-surfaces.mjs --require-review  exit 1 if a touched
//                                                               surface has no recorded review
//
// WHY THIS EXISTS. A comprehensive security checklist was already in place, and it
// already contained the exact item that was missed — "Any secret in a query string?".
// It was never consulted, because consulting it depended on the author deciding the
// change was security-relevant, and that decision is precisely what failed: the
// credential channel was framed as a UX detail.
//
// So the trigger is moved off judgement and onto the diff. This script does not
// review anything. It answers one mechanical question — what did this change touch —
// so that the depth of the review that follows is decided by the change rather than
// by whoever is looking at it.
//
// It also answers the "a full scan every time is too heavy" problem: the SURFACES
// select which sections of the checklist apply, so a small change gets a small
// review instead of the whole thing or nothing.

import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * A surface is a kind of security-relevant thing a diff can touch. `patterns` match
 * ADDED or MODIFIED lines (not deletions — removing an HMAC is a different question
 * and shows up as the code that replaced it). `paths` match the file itself.
 *
 * Deliberately over-inclusive: a false positive costs a few minutes of reading, a
 * false negative is what shipped `?__stg=<key>`.
 */
export const SURFACES = [
  {
    id: "credential",
    label: "資格情報の生成・保管・比較・送出",
    sections: ["Secrets handling", "Transport security"],
    questions: [
      "この値はどの経路を通るか。通った先（サーバログ・CDN ログ・アドレスバー・履歴・ブックマーク・Referer・ブラウザ同期・スクショ・コピペ・エラーレポート）を誰が読めるか",
      "URL（クエリ・パス・フラグメント）に載っていないか",
      "ログや例外メッセージに値が出ないか（語ではなく値）",
      "保管は Keychain / secret manager か、平文ファイルか",
      "比較は定時間か。ローテートは 1 手で、既存の資格が即無効になるか",
    ],
    patterns: [
      /\b(secret|credential|api[_-]?key|access[_-]?key|apikey|password|passwd|bearer)\b/i,
      /\btoken\b/i,
      /\bKeychain\b|security\s+(find|add)-generic-password/i,
      /\btimingSafeEqual\b|\bequalsConstantTime\b|\bcreateHmac\b|crypto\.subtle\.(sign|verify)\b/,
    ],
  },
  {
    id: "authz",
    label: "認証・認可の判断",
    sections: ["Auth / authorization"],
    questions: [
      "保護された経路すべてで検証されるか。抜け道（dev 用の分岐、既定資格、無効化フラグ）はないか",
      "各ハンドラは呼び出し元がその対象を所有/参照してよいことを確認しているか（リクエストの ID を信用していないか）",
      "権限の投影は境界で行われ、UI で隠しているだけになっていないか",
      "失敗時は fail-closed か。判断不能なとき通してしまう分岐はないか",
    ],
    patterns: [
      /\brequire[A-Z]\w*(Principal|Membership|Access|Auth)\b/,
      /\b(authorize|authenticate|authorization)\b/i,
      /\b(projectRole|tenantRole|permission|isAdmin|canEdit)\b/,
      /\bmiddleware\b/,
    ],
  },
  {
    id: "surface",
    label: "外部から到達できる新しい口",
    sections: ["Auth / authorization", "SSRF & outbound requests"],
    questions: [
      "認証なしで到達できるか。到達できるなら、それは意図か",
      "その口は他の口と同じ認可を通るか（1 つだけ素通しになっていないか）",
      "GET で副作用や課金が起きないか（プリフェッチで発火しないか）",
      "入力の上限（本文サイズ・件数）はあるか",
    ],
    paths: ["/app/routes/", "/workers/", "routes.ts"],
    // Two flat patterns rather than one with an optional group between two `\s+`:
    // simpler to reason about, and nothing here needs to backtrack.
    patterns: [/\bfunction\s+loader\b/, /\bfunction\s+action\b/, /\bfetch\s*\(\s*request\b/],
  },
  {
    id: "cookie-header",
    label: "Cookie・セキュリティヘッダ",
    sections: ["Secrets handling", "Transport security", "XSS / output handling"],
    questions: [
      "Cookie は HttpOnly / Secure / SameSite か。値は資格情報そのものではなく導出値か",
      "そのレスポンスヘッダは、より厳しい既存のヘッダを上書きしていないか",
      "CSP を足す/変えるとき、外部送信の口（img-src / connect-src）は閉じているか",
    ],
    patterns: [/set-?cookie/i, /headers\.set\s*\(/, /Content-Security-Policy/i, /\bSameSite\b/],
  },
  {
    id: "deploy-target",
    label: "デプロイ先・環境の追加や変更",
    sections: ["*"], // a new environment adds every surface at once
    questions: [
      "公開されるか。公開されない前提なら、その守りは成果物の中にあるか（外側の設定に依存していないか）",
      "本番の資格情報・データに到達できないか。取り違えを拒否するガードはあるか",
      "その環境の秘密は本番と別か",
      "デプロイ経路に人間の承認が要るか要らないか、それは意図どおりか",
    ],
    paths: ["wrangler.json", ".github/workflows/", "deploy-staging"],
    patterns: [/\bDEPLOY_ENV\b/, /wrangler\s+(deploy|secret\s+put)/],
  },
  {
    id: "data-boundary",
    label: "データ境界（永続化・マイグレーション）",
    sections: ["SQL / NoSQL / query injection", "Auth / authorization"],
    questions: [
      "クエリは値をパラメータとして渡しているか（文字列連結でないか）",
      "テナント/プロジェクトのスコープはクエリ側で強制されているか",
      "マイグレーションの適用先を取り違えないガードはあるか",
    ],
    paths: ["packages/persistence/", "migration"],
    patterns: [/\bDATABASE_URL\b/, /\bsql`/, /\bdrizzle\b/],
  },
];

/** A commit trailer records that the depth-1 review happened, and for which surfaces. */
export const REVIEW_TRAILER = "Security-Reviewed";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Pure core. `files` is `[{ file, addedLines }]`; returns the surfaces touched, with
 * the evidence that put each one there — so a reader can tell a real hit from an
 * over-inclusive one without re-running anything.
 */
export function classifySurfaces(files) {
  const touched = new Map();
  for (const surface of SURFACES) {
    for (const { file, addedLines } of files) {
      // Plain substrings, not regexes: path matching needs no backtracking, and the
      // substring doubles as the evidence a reader sees.
      const byPath = (surface.paths ?? []).find((fragment) => file.includes(fragment));
      const bodyMatch = (surface.patterns ?? [])
        .map((pattern) => {
          const line = addedLines.find((added) => pattern.test(added));
          return line === undefined ? null : { pattern: String(pattern), line: line.trim().slice(0, 120) };
        })
        .find((hit) => hit !== null);
      if (byPath === undefined && bodyMatch === undefined) continue;

      const existing = touched.get(surface.id) ?? { surface, evidence: [] };
      existing.evidence.push({
        file,
        ...(byPath === undefined ? {} : { path: byPath }),
        ...(bodyMatch === undefined ? {} : bodyMatch),
      });
      touched.set(surface.id, existing);
    }
  }
  return [...touched.values()];
}

/** Added/modified lines per file, from a unified diff. Deletions are ignored. */
export function parseDiff(diff) {
  const files = [];
  let current = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (header !== null) {
      current = { file: header[1], addedLines: [] };
      files.push(current);
      continue;
    }
    if (current !== null && line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push(line.slice(1));
    }
  }
  return files.filter((entry) => entry.addedLines.length > 0);
}

/**
 * Which surfaces were recorded as reviewed, from raw commit messages.
 *
 * Scans the whole message rather than using git's `%(trailers)`. Git treats only the
 * LAST paragraph as trailers, so a `Security-Reviewed:` line separated from the
 * `Co-Authored-By:` block by a blank line is silently not a trailer — which is
 * exactly what happened on this gate's first real use: the line was written, and the
 * gate said it was missing. The point is to record that a review happened, not to
 * enforce trailer syntax, so anywhere in the message counts.
 */
export function parseReviewedSurfaces(messages) {
  const prefix = `${REVIEW_TRAILER.toLowerCase()}:`;
  const found = new Set();
  for (const line of messages.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(prefix)) continue;
    for (const value of trimmed.slice(trimmed.indexOf(":") + 1).split(",")) {
      const id = value.trim();
      if (id.length > 0) found.add(id);
    }
  }
  return found;
}

function reviewedSurfaces(range) {
  return parseReviewedSurfaces(range === null ? "" : git(["log", "--format=%B", range]));
}

function main() {
  const rangeFlag = process.argv.indexOf("--range");
  const range = rangeFlag === -1 ? null : process.argv[rangeFlag + 1];
  const requireReview = process.argv.includes("--require-review");

  const diff = range === null ? git(["diff", "--cached", "-U0"]) : git(["diff", "-U0", range]);
  const touched = classifySurfaces(parseDiff(diff));

  if (touched.length === 0) {
    console.log(JSON.stringify({ event: "security_surfaces", touched: [], depth: 0 }));
    return;
  }

  const report = {
    event: "security_surfaces",
    depth: 1,
    touched: touched.map(({ surface, evidence }) => ({
      id: surface.id,
      label: surface.label,
      sections: surface.sections,
      questions: surface.questions,
      evidence: evidence.slice(0, 3),
    })),
  };
  console.log(JSON.stringify(report, null, 2));

  if (!requireReview) return;

  const reviewed = reviewedSurfaces(range);
  const unreviewed = touched.map(({ surface }) => surface.id).filter((id) => !reviewed.has(id));
  if (unreviewed.length > 0) {
    console.error(
      `\nThis change touches security surfaces with no recorded review: ${unreviewed.join(", ")}.\n` +
        `Read the questions above against the diff, then record it as a commit trailer:\n` +
        `  ${REVIEW_TRAILER}: ${unreviewed.join(", ")}\n` +
        `A trailer cannot prove the review was good. It makes SKIPPING it a deliberate act\n` +
        `rather than a silent omission, which is the failure this exists to prevent.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
