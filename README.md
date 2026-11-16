# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/SufTTY/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/SufTTY/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process and zero npm dependencies: git smart HTTP
(upload-pack protocol v2 and v0, receive-pack v0 with report-status, side-band-64k, shallow
fetches, tags), the GitHub REST v3 API under `/api/v3`, the GraphQL v4 API at `/api/graphql`, and
a Model Context Protocol endpoint at `/mcp` — all over one in-memory store, so a repository, an
issue or a pull request created on one surface is the same object on the others.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register` and polls
`GET $MAKEFUN_ENV_URL/done` until the trial's suite finishes, then exits 0.

## What it implements

- **git smart HTTP** at `/{owner}/{repo}.git/...`: `GET /info/refs?service=git-upload-pack`
  (protocol v2 capability advertisement, `ls-refs` with `peel`, `symrefs`, `unborn` and
  `ref-prefix` filtering, `fetch` with `shallow`, `deepen`, `have`/`want` negotiation, side-band
  packs, an annotated tag travelling with its target) and protocol v0 (`multi_ack_detailed`,
  `thin-pack`, `ofs-delta`, `shallow`), plus `git-receive-pack` with `report-status`,
  fast-forward and ancestor checks, ref create/update/delete and tag deletion.
- **REST v3** (`/api/v3`): `/`, `/meta`, `/user`, `/user/repos` (create, paginated list with
  `Link: rel="next"`), `/repos/{owner}/{repo}` (get, PATCH, DELETE), contents (read, create,
  update with sha checks, delete, directories), branches, commits, git refs, labels, issues
  (create, list with state/sort/direction, get, PATCH, comments), pull requests (create from
  branch heads, list with state, get, files with additions/deletions, merge with conflict and
  unknown-PR handling), JSON errors with `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** (`/api/graphql`): a hand-written parser and resolver for the documents `gh` and
  `github-mcp-server` send — variables, aliases, inline fragments, fragments, batched operations,
  `__type` introspection for `Issue`, `PullRequest`, `Repository` and `SearchType`, and the
  `createIssue`, `addComment`, `closeIssue`, `createPullRequest` and `mergePullRequest`
  mutations with stable node ids.
- **MCP** (`/mcp`, Streamable HTTP, JSON-RPC 2.0): `server/discover` and `initialize` for
  revision `2026-07-28` and the older revisions, `tools/list`, `tools/call` for `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request`, with `401` on an unauthenticated call and JSON-RPC errors for unknown
  tools and bad params.

Everything lives in memory: no database, no disk, no npm package — `node:zlib`, `node:crypto` and
`node:http` only. Packfiles, deltas and pkt-line framing are implemented in `src/gitobj.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
