# リリースとロールバック

## リリース単位

一つのリリースは、`main` の Git commit と Cloudflare Worker version ID の組で識別する。
Worker には commit SHA が `--tag` として記録されるため、稼働中の version からその出所の commit を必ず辿れる。

配信対象は Worker 一つ（`apps/web`）だけである。
React Router の SSR アプリと Hono の `/api`・`/mcp` が同一 Worker に同居し、静的 asset は Worker の `ASSETS` binding が配信する。

データベース変更は、後方互換な拡張、アプリケーションの切替、不要構造の削除という複数リリースに分ける。
Worker のロールバックは migration を戻さないため、同じスキーマで旧版と新版の双方が動く期間を設ける。

## 配信の起動条件

`main` への push だけが本番配信を起動する。
`.github/workflows/deploy.yml` が唯一の配信経路であり、手元の `wrangler deploy` は使わない。
つまり「本番で何が動いているか」は常に `main` の内容であり、誰かの手元の記録に依存しない。

commit を変えずに配信をやり直したい場合（secret のローテーション直後など）だけ、同 workflow を `workflow_dispatch` で実行する。

workflow は次の順で進む。いずれかが失敗した時点で配信は中止される。

1. `pnpm check`（lint、typecheck、全テスト、operations テスト、build）と `pnpm types:worker --check`。
   検査を配信 job の中に置いてあるため、配信が自分の検査を追い越すことはない。
2. `pnpm --dir apps/web build`。
3. `node .github/scripts/materialize-deploy-config.mjs`。
4. `wrangler deploy -c build/server/wrangler.json --name "$WORKER_NAME" --tag "$GITHUB_SHA"`。
5. `node .github/scripts/verify-deployment.mjs`。

## 設定の materialize

`apps/web/wrangler.jsonc` は `.invalid` のプレースホルダを保持したまま git 管理される。
実際の値は materialize 手順が **build 成果物**（`apps/web/build/server/wrangler.json`、gitignore 対象）にだけ書き込む。
git 管理下のファイルを配信のたびに手で書き換えて戻す運用は取らない。
このリポジトリは public であり、その書き換えの間に一度でも `git commit -a` が走れば履歴に残るためである。

materialize 手順は、過去に実際に踏んだ罠を検査する。

- `MCP_RESOURCE_URL` の path が `/mcp` であること。ここが違うと `/mcp` の audience が静かに壊れる。
- `OIDC_REDIRECT_URI` が `/auth/callback` で、かつ `MCP_RESOURCE_URL` と同一 origin であること。旧ホストのまま残った redirect URI は配信自体は成功し、ログインで初めて失敗する。
- rate-limit namespace ID が相異なる正の整数であること。
- `assets.directory` が build 成果物に存在すること。欠けると Worker は更新されるのに asset は旧版のまま配信される。
- `.invalid` がどこにも残っていないこと。

Worker 名も materialize 手順が設定する。
`--name` の指定漏れで別 Worker に配信され、本番が黙って据え置かれる事故を防ぐためである。

## 配信の検証

`verify-deployment.mjs` は、version ID ではなく**利用者が実際に受け取るもの**を確認する。
`wrangler deploy` は、旧 asset を配信し続ける Worker を上げた場合でも成功と新しい version ID を報告するため、version ID は配信の証拠にならない。

検査内容は次の四つである。

- `/` が参照する `/assets/*` がすべて今回の build 成果物に存在すること（伝播待ちのためポーリングする）。
- `/api/health` が 200 を返すこと。
- `/.well-known/oauth-protected-resource/mcp` が 200 を返し、`resource` が `MCP_RESOURCE_URL` と一致すること。
- 未認証の `POST /mcp` が 401 を返し、`WWW-Authenticate` に `resource_metadata` を含むこと。

cookie session を必要とする経路（ログイン往復、WBS 画面の SSR、書き込み）は資格情報なしでは検証できないため、配信後に人が確認する。

## GitHub Environment の設定

Environment `production` に次を登録する。
required reviewer を設定すれば、`main` へのマージ後に人の承認を挟める。設定しなければマージがそのまま配信になる。

- Secrets: `CLOUDFLARE_API_TOKEN`。Workers Scripts の編集権限に限定し、対象 account だけを許可する。
- Variables: `CLOUDFLARE_ACCOUNT_ID`、`WORKER_NAME`、`VECTA_BASE_URL`、`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_JWKS_URL`、`OIDC_REDIRECT_URI`、`OIDC_AUTH_ENDPOINT`、`OIDC_TOKEN_ENDPOINT`、`MCP_RESOURCE_URL`、`PRE_AUTH_RATE_LIMIT_NAMESPACE_ID`、`AUTH_RATE_LIMIT_NAMESPACE_ID`、`COMPUTE_RATE_LIMIT_NAMESPACE_ID`。

これらの variables はいずれも秘密値ではない。
OIDC の client ID と redirect URI はサインイン時にブラウザの URL に現れ、MCP の resource identifier は無認証の metadata document で配信される。
variables として持つ理由は秘匿ではなく、git 管理下のファイルを手で書き換えずに配信を再現可能にすることにある。

真の秘密は Worker secret として保持し、CI を通さない。

- `OIDC_CLIENT_SECRET`: Google の confidential client secret。authorization code の交換に使う。
- `SESSION_SECRET`（および rotation 時の `SESSION_SECRET_PREVIOUS`）: httpOnly cookie session の署名鍵。
- `DATABASE_URL`: Neon の接続文字列。

いずれも `wrangler secret put <NAME> --name <WORKER_NAME>` で一度登録すれば配信をまたいで保持される。
値を画面やログに出さず、標準入力へ直接流し込む。

## migration

スキーマ変更があるときだけ、配信の前に一度だけ適用する。

```sh
DEPLOY_ENV=production DATABASE_URL=<接続文字列> \
EXPECTED_DATABASE_HOST=<host> EXPECTED_DATABASE_NAME=<dbname> \
pnpm --dir packages/persistence db:migrate
```

`packages/persistence/scripts/migrate.mjs` が接続先の host と database 名の一致を確認し、PostgreSQL advisory lock を取得してから Drizzle migration を適用する。
本番の migration を、その場限りの JavaScript や SQL のループで実行しない。

## ロールバック

```sh
pnpm --dir apps/web exec wrangler versions list --name <WORKER_NAME>
pnpm --dir apps/web exec wrangler rollback <KNOWN_GOOD_VERSION_ID> --name <WORKER_NAME> --message "incident rollback"
```

version ID は資格情報ではないが、誤った version を指さないよう変更記録からコピーする。

binding の形が変わった配信をまたぐロールバックは Cloudflare が拒否することがある。
その場合は古い commit をそのまま再配信せず、`main` を revert して通常の配信経路でやり直す。

どちらの場合も migration は戻らない。
直前のリリースがスキーマを変更していたなら、旧版がその新しいスキーマで動くことを先に確認する。

## ロールバック後

配信の自動検証（`verify-deployment.mjs`）に加えて、ログイン往復、WBS 画面の表示、書き込みが一巡することを人が確認する。
Worker の成功応答だけで完了と判断せず、書き込みは再読み込み後に永続化されていることまで見る。

参照：[Cloudflare Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
