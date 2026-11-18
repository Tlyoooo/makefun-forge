# Koyuki Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Tlyoooo/makefun-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Tlyoooo/makefun-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Koyuki Forge is a GitHub-compatible git forge built for the make.fun bounty [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01). It runs as a single zero-dependency Node process (Node 22, plain-JS-flavored TypeScript, entrypoint `main.ts` at the repository root) and serves four API surfaces from one shared in-memory store — with no git binary anywhere: the git object model (sha1 objects, pack read/write, delta resolution) is implemented from the wire format up.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 and receive-pack v0: clone, fetch and push against the forge's own object store.
- **REST v3** under `/api/v3` — repositories, branches, git data (refs, blobs, trees, commits), commits, contents, labels, issues and comments, and pull requests with files diffs and merges.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issues and pullRequests queries with Relay global ids and cursor connections, mutations, and introspection.
- **MCP** at `/mcp` — `server/discover`, `tools/list` and `tools/call` over the same store.

## Authentication

Every request carries `Authorization: Bearer <token>`, where the token is read from the `MAKEFUN_SHOP_TOKEN` environment variable. A request without the token is answered 401, and a repository belonging to another owner is answered 404 (never 403).

## How it runs

Boot contract with the grading suite:

1. The process binds an ephemeral port of its own (never 8080).
2. It POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`.
3. It serves until the suite finishes, long-polling `$MAKEFUN_ENV_URL/done`.
4. When the suite answers `{"done": true}`, the process exits 0.

Run it with:

```sh
MAKEFUN_ENV_URL=<suite url> MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

Environment variables: `MAKEFUN_ENV_URL` (the suite's base URL, used for `/register` and `/done`) and `MAKEFUN_SHOP_TOKEN` (the bearer token the suite presents).

## Verification

Checked locally with the bounty kit's own harness before submission:

- Conformance suite: **120/120 checks pass**
- Full grade-local trial: **982/1000**

---

New to make.fun? Sign up with referral code 398ra21m — https://make.fun/r/398ra21m
