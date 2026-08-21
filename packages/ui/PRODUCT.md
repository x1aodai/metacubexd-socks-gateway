# MetaCubeXD SOCKS Gateway product

## Users

The product serves an operator or small team that needs a simple, self-hosted
way to expose several authenticated SOCKS5 entries through a shared node pool.
Users should not need to understand Mihomo's complete configuration model to
bind accounts, choose a route or identify a failed listener.

## Core jobs

- Configure the ten fixed ports `10001`–`10010` without editing raw YAML.
- Bind one account to several ports or several accounts to one port.
- Maintain a small node pool through manual imports and subscriptions.
- Explicitly choose one-hop or two-hop routing per port.
- Choose manual, automatic-best or failover behavior for each Hop.
- See whether configuration applied and which node is currently active.
- Recover safely from an invalid change without losing the last working state.

## Product surface

The interface is Chinese-only and contains four pages:

| Page   | Primary job                                                            |
| ------ | ---------------------------------------------------------------------- |
| `端口` | Edit credentials, Hop count, candidates and mode for each fixed port   |
| `节点` | Import, test, enable, disable and delete Nodes; manage Subscriptions   |
| `账号` | Create, bind, disable, delete and rotate SOCKS Credentials             |
| `系统` | Inspect services, versions, listeners and apply history; reapply state |

Login always enters `端口`. Navigation does not expose implementation-level
Mihomo controls.

## Scope boundaries

- Port numbers and management bindings are fixed deployment contracts.
- Credentials and ports are many-to-many and have no product-level count cap.
- A route has one or two Hops. Hop count changes only through an explicit edit.
- Any enabled Node can be used as either Hop, subject to the consecutive-node
  safety rule.
- Manual mode never silently switches Nodes. Auto and failover operate only
  within the candidates explicitly stored for that Hop.
- Subscription exclusions persist, and failed refreshes retain last-known-good
  Nodes.
- The runtime is fail closed: no UDP, IPv6 SOCKS or `DIRECT` fallback.

The product does not aim to expose every Mihomo feature or become a general
server administration interface. New capabilities must solve a demonstrated
gateway job without weakening the fixed network contract.

## Product principles

- **Fast first success.** A new operator can progress Nodes → Credentials →
  Ports without learning internal topology.
- **Explicit routing.** Always show configured Hop count, mode and current
  runtime choice separately.
- **Safe mutation.** Prevent duplicate actions, preview destructive impact and
  report whether a change applied or rolled back.
- **No hidden fallback.** A failed route is visible and rejected; convenience
  never overrides the operator's route.
- **Secrets are ephemeral in the UI.** Show generated SOCKS passwords once and
  clear them when the dialog closes.
- **Plain failure language.** Errors identify the affected operation and retain
  the last useful state without exposing internal or sensitive detail.
- **Small-screen parity.** The same four jobs remain available at narrow widths;
  layout changes, capability does not.

## Accessibility

- Every action has a visible label or accessible name and a keyboard path.
- Focus remains visible and dialogs return control predictably.
- Health, success and failure use words or icons as well as color.
- Loading and disabled states prevent duplicate changes without hiding outcome.
- Dense identifiers and port numbers remain selectable and legible.

Visual and interaction rules live in [DESIGN.md](./DESIGN.md).
