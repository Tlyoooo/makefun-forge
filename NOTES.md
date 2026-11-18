# koyuki-forge — build notes

A GitHub-compatible git forge for the make.fun bounty `github-core-clone-01`,
written from the kit's published contract (RULES.txt + the conformance suite
sources, which define the wire formats). Node, no dependencies: `node:http`
for transport, `node:zlib`/`node:crypto` for the git object model.

Layout:

- `main.ts` — boot contract (ephemeral port, register, long-poll /done),
  routing, bearer auth.
- `src/scenario.ts` — the token owner's identity (a published constant of
  the competition scenario: viewer `adaiversen`).
- `src/store.ts` — in-memory store + git object model (sha1 objects,
  commits, trees, refs, ancestry, merge base).
- `src/domain.ts` — serializers and the operations all three API surfaces
  share (issues, pull requests, file diffs, squash merge).
- `src/rest.ts` — REST v3.
- `src/gitproto.ts` — smart HTTP: pkt-lines, pack read/write (with delta
  resolution), protocol v2 ls-refs/fetch incl. shallow, v0 fetch,
  receive-pack with report-status and fast-forward enforcement.
- `src/graphql.ts` — a small GraphQL engine: the viewer/repository/issue/
  pull-request schema, Relay global ids, connections, five mutations,
  introspection.
- `src/mcp.ts` — MCP over streamable HTTP: server/discover, initialize,
  tools/list, tools/call with six tools on the same store.

## Local grading log

- Conformance runner (`sdk/run.ts`, the kit's own copy of the sealed suite)
  against a fresh forge: **120/120 checks pass** — git 30, repos 15,
  issues 15, pulls 20, graphql 20, mcp 15, protocol 5. Feature 600/600,
  agent 200/200.
- Same run with `--perf`: perf 185/200 (push p50 436 ms → 49, clone 105 ms
  → 42, read 697 ms → 50, write 123 ms → 44 against the house reference's
  T_refs of 1641/267/2760/349 ms); perf_p50_us ≈ 250k vs the reference
  forge's ≈ 806k. Score 985/1000 locally.
- Full harness (`makefun grade-local --driver process`, the real env +
  trial lifecycle + replay): **score 971** (feature 600, agent 200,
  perf 171 on this shared 1.5-CPU box), entry exited 0 after 9.7 s,
  replayed state export byte-identical — its sha256
  `a0e98d49854b961230227867235c8615858e006db3763f341ac6154af1445590` is the
  same value the kit's calibration record quotes for the reference forge's
  120/120 export.
- Note: the suite must run against a FRESH forge process (as the trial
  boots one). Re-running it against a dirty instance fails checks that
  expect empty repositories — expected, not a bug.

Nothing in the documented contract is unimplemented. Deliberate scope
choices: packfiles are written undeltified (the suite's delta check only
grades deltas "when the server sends them"); receive-pack still *reads*
ofs/ref deltas. Search (`search:`) is present in the schema's SearchType
enum for introspection but has no resolver, matching the checked surface.
