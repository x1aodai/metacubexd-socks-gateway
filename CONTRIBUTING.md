# Contributing to MetaCubeXD SOCKS Gateway

Keep changes focused on the fixed-port gateway. Explain the operator impact,
add regression coverage and list every check that was actually run.

Security concerns must follow [.github/SECURITY.md](.github/SECURITY.md).
Never include a real secret while discussing or testing a change.

## Setup

Requirements:

- the Node.js version pinned in [`.node-version`](.node-version)
- Corepack and the pnpm version pinned in [`package.json`](package.json)
- Linux Docker when changing or validating the production container

```sh
corepack enable
pnpm install --frozen-lockfile
```

The active workspace is intentionally small:

| Workspace        | Responsibility                                              |
| ---------------- | ----------------------------------------------------------- |
| `packages/ui`    | Chinese four-page Web console                               |
| `packages/agent` | Gateway state, subscriptions, Mihomo config and supervision |
| `apps/server`    | Authentication, API integration and container entrypoint    |

Read [CONTEXT.md](CONTEXT.md) before changing a cross-package contract. UI work
must also follow [PRODUCT.md](packages/ui/PRODUCT.md) and
[DESIGN.md](packages/ui/DESIGN.md).

## Development commands

Run commands from the repository root:

```sh
pnpm dev             # Web development server
pnpm dev:server      # build Web, then start the all-in-one Server
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Targeted checks are useful while iterating:

```sh
pnpm --filter @metacubexd/agent test
pnpm --filter @metacubexd/server test
pnpm --filter @metacubexd/ui test:unit
pnpm --filter @metacubexd/ui test:e2e
```

The Web end-to-end suite requires Playwright Chromium. Install it with:

```sh
pnpm --filter @metacubexd/ui exec playwright install chromium
```

## Implementation rules

- Use incremental TDD: obtain the expected failing test, make the smallest
  implementation, then run the owning package's test and typecheck.
- Keep ports `10001`–`10010`, Web `127.0.0.1:8080` and Controller
  `127.0.0.1:9090` fixed. Never add a public path to the Controller.
- Preserve TCP-only authenticated SOCKS, disabled UDP/IPv6 and fail-closed
  routing without `DIRECT`.
- Keep every gateway mutation transactional. Do not persist a candidate until
  runtime and listener verification pass.
- Keep the four Web pages and Chinese-only operator vocabulary synchronized
  with API DTOs.
- Pin direct dependencies exactly and regenerate `pnpm-lock.yaml` through pnpm;
  do not hand-edit the lockfile.
- Do not add an abstraction, dependency or configuration switch for a need that
  is not present in the approved product scope.
- Do not edit generated `.nuxt`, `.nitro`, `.output` or runtime data.

## Secrets and test data

The following are sensitive: administrator passwords, session cookies, CSRF
tokens, gateway master keys, Controller secrets, SOCKS passwords, subscription
URLs, node share links and encrypted state. Use obvious fake values in fixtures.
Do not place sensitive values in logs, snapshots, screenshots, issues, pull
requests or evidence files.

Runtime files belong only in ignored `data/`, `.runtime/` or disposable test
directories. Tests must not alter a host firewall, system routing or a real
deployment.

## Deployment changes

Run the static contract checks for deployment or distribution changes:

```sh
node deploy/verify-contract.mjs
node deploy/verify-distribution.mjs
```

When Linux Docker is available, build and smoke a local image:

```sh
docker buildx build --load --platform linux/amd64 \
  -f apps/server/Dockerfile -t socks-gateway:mvp .
bash deploy/smoke.sh --image socks-gateway:mvp --evidence ./smoke-evidence.jsonl
```

If Docker, Linux host networking or a real node is unavailable, record the
corresponding gate as `not-run`; do not present a static template as runtime
validation.

## Documentation and pull requests

Update operator docs when behavior, networking, configuration, provenance or
the four-page workflow changes. Format Markdown with the repository Prettier:

```sh
pnpm exec prettier --check README.md CONTRIBUTING.md .github/SECURITY.md
```

Use focused Conventional Commits, for example
`fix(agent): preserve the active route on apply failure`. A pull request should
include:

- the problem and minimal solution;
- tests and manual checks, including platform;
- visible before/after evidence for Web changes;
- deployment, migration and security implications;
- every unrun acceptance gate.
