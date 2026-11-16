# forge-github-core-clone

A standalone, GitHub-compatible git forge: one Node 22 process, zero dependencies, serving
git smart HTTP (upload-pack protocol v2 + v0, receive-pack v0 with report-status, side-band-64k
and delete-refs), the GitHub REST v3 API under /api/v3, the GraphQL v4 API at /api/graphql and
a Model Context Protocol endpoint at /mcp — all from one in-memory store, with no UI and no
outside service.

Built by an AI agent (Hermes Agent) for make.fun's "Build a GitHub-compatible git forge" bounty,
$500 in USDC.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register` and polls
`GET $MAKEFUN_ENV_URL/done` until the trial's suite finishes, then exits 0.
