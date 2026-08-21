# Copilot instructions: MetaCubeXD SOCKS Gateway

## Scope

This repository is a focused, all-in-one SOCKS gateway. Do not infer the feature
set of the larger project from which it was derived. Product expansion requires
an approved specification.

The only workspaces are:

| Workspace        | Ownership                                                           |
| ---------------- | ------------------------------------------------------------------- |
| `packages/ui`    | Chinese Web console and Gateway API client                          |
| `packages/agent` | encrypted state, subscriptions, Mihomo config and process lifecycle |
| `apps/server`    | administrator auth, same-origin API and container runtime           |

Use [CONTEXT.md](../CONTEXT.md) for domain terms. UI behavior and presentation
must follow [PRODUCT.md](../packages/ui/PRODUCT.md) and
[DESIGN.md](../packages/ui/DESIGN.md).

## Non-negotiable network contract

- Web and Gateway API: `127.0.0.1:8080`.
- Mihomo Controller: `127.0.0.1:9090`; never expose or proxy it.
- SOCKS listeners: fixed `10001`–`10010/tcp`; disabled slots do not listen.
- SOCKS requires a bound, enabled credential.
- UDP and IPv6 SOCKS are disabled.
- Generated routing ends in `REJECT`, never `DIRECT`.
- The container uses host networking, drops all capabilities, has a read-only
  root filesystem, writes persistent data only to `/data` and scratch data only
  to `/tmp`.

Do not add configurable bind addresses, variable port ranges, public Controller
paths or alternate direct-access modes.

## State and API rules

- Administrator requests use the Session cookie; state-changing requests also
  require CSRF. The health endpoint is the only public Control endpoint.
- Product routes stay under `/api/control/gateway/**`.
- Validate request bodies strictly and return safe public DTOs. Never return
  stored passwords or raw internal errors.
- Credentials and ports are many-to-many. Passwords are returned only on create
  or rotate.
- Routes have one or two Hops. Hop mode is `manual`, `auto` or `failover`.
- Hop count changes only through an explicit port edit.
- Every mutation uses the transactional apply path: validate, generate, restart,
  verify, persist. Roll back both runtime and state on failure.
- Node IDs are stable connection identities. Preserve subscription exclusions
  and last-known-good data.

## Web rules

- Navigation contains exactly `端口`、`节点`、`账号`、`系统`; login enters
  `端口`.
- Keep operator text in concise Simplified Chinese.
- Use the existing light palette, responsive side/bottom navigation and native
  dialog pattern. Do not add another design system.
- Separate mutation success from a later refresh failure. Prevent duplicate
  actions and clear one-time secrets from state when their dialog closes.
- Poll only read-only status, guard overlapping requests and stop timers when a
  view unmounts.
- Preserve keyboard focus, accessible names and text/icon status cues.

## Development workflow

Use incremental TDD. Start with the narrow failing test, implement the minimum,
then run the owning package's complete test and typecheck. Before handoff run as
applicable:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node deploy/verify-contract.mjs
node deploy/verify-distribution.mjs
```

Linux Docker smoke is:

```sh
bash deploy/smoke.sh --image socks-gateway:mvp --evidence ./smoke-evidence.jsonl
```

Unavailable runtime gates are `not-run`, never assumed pass.

## Change hygiene

- Use exact dependency versions and regenerate the lockfile with pnpm.
- Keep secrets, URLs, cookies, keys and encrypted state out of code, fixtures,
  logs, screenshots and evidence.
- Do not hand-edit generated output or runtime files.
- Preserve the root MIT license, `NOTICE` and Mihomo GPL/source provenance.
- Prefer deletion and direct code over speculative abstractions, switches or
  dependencies.
