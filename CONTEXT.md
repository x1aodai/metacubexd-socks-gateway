# MetaCubeXD SOCKS Gateway context

This document fixes the product vocabulary and boundaries used by the Web,
Server and Agent packages.

## Product boundary

**SOCKS Gateway** is the complete product: one all-in-one service that serves a
Chinese management console, supervises Mihomo and exposes up to ten managed
TCP SOCKS5 listeners. It is not a general-purpose Mihomo control surface.

The repository has three runtime workspaces:

- **Web** (`packages/ui`): the four-page browser console.
- **Server** (`apps/server`): administrator authentication, static Web delivery
  and same-origin Gateway API integration.
- **Agent** (`packages/agent`): persisted gateway state, subscription parsing,
  Mihomo configuration generation, process supervision and transactional apply.

**Mihomo** is the managed proxy process. Its Controller is an implementation
detail fixed to `127.0.0.1:9090`; operators and browsers do not connect to it.

## Network vocabulary

**Management endpoint**: the Web and API listener fixed to
`127.0.0.1:8080`. Remote access terminates at a same-host HTTPS reverse proxy or
an SSH tunnel.

**Controller**: Mihomo's loopback-only control listener at
`127.0.0.1:9090`. Never call it a public API or document it as an operator
endpoint.

**Port Slot**: one of ten immutable entries with IDs `1`–`10`, mapped in order
to TCP ports `10001`–`10010`. A disabled Port Slot has no listener.

**SOCKS Listener**: the authenticated TCP SOCKS5 listener generated for an
enabled Port Slot. UDP and IPv6 SOCKS are not supported.

## Managed resources

**Credential**: a SOCKS username and password. Credentials and Port Slots have
a many-to-many relationship. Public API responses never return the stored
password; creation and rotation responses return it once.

**Node**: a stable outbound identity derived from connection fields rather than
its display name. A Node may be used in either hop and by any number of Port
Slots.

**Node Source**: either a manual import or a managed Subscription. The same
stable Node can appear in more than one source.

**Subscription**: a refreshable remote Node Source. Its URL is sensitive.
Explicit node exclusions persist across refreshes, and a failed or empty
refresh retains the last known good source.

**Node Pool**: the operator-visible collection of Nodes from every source.
There is no configured business maximum.

## Route vocabulary

**Hop**: one routing stage in a Port Slot. A route contains one or two Hops.
Hop count changes only through an explicit operator edit.

**Manual**: exactly one configured Node. Runtime failure does not silently
select another Node.

**Auto**: Mihomo measures the configured candidates and selects the current
best candidate.

**Failover**: Mihomo uses the first available candidate in configured order.

**One-hop route**: a Port Slot whose SOCKS traffic exits through one Hop.

**Two-hop route**: a Port Slot whose second-hop connection is dialed through
the first Hop. The same stable Node cannot occupy consecutive Hops.

**Fail closed**: when a route has no usable candidate, traffic is rejected.
`DIRECT` is never a generated fallback.

## State and operations

**Candidate State**: an in-memory copy produced for a requested mutation. It
must validate before Mihomo is restarted.

**Active State**: the encrypted, committed gateway state currently expected to
match the running Mihomo configuration.

**Apply**: validate Candidate State, generate configuration, restart Mihomo,
verify the Controller and every enabled listener, then persist. Any failure
restores the prior Active State and runtime.

**Revision**: an encrypted record of a successful committed state transition.
Failed candidates do not remain in revision history.

**Gateway Status**: read-only projection of service versions, listener health,
Port Slot health, active hop choices and the most recent apply result.

## Web navigation

The only product pages are **Ports**, **Nodes**, **Credentials** and **System**,
shown in Chinese as `端口`、`节点`、`账号`、`系统`. Login redirects to Ports.
