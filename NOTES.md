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

- (pending first run)
