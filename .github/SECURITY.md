# Security Policy

## Supported code

Security fixes, when provided, target the current development branch. If gateway
images are published, only the newest identified digest may receive a fix.
There is no commitment to backport fixes to older commits or images. Use an
immutable image digest so the deployed artifact is identifiable.

## Private reporting status

As of **2026-08-21**, this fork has not verified that a private vulnerability
reporting channel is enabled or monitored. Do not assume that GitHub private
vulnerability reporting, an email address or the shared MetaCubeXD upstream
channel will reach this fork's maintainer.

Before sending vulnerability details, check the current repository owner and
repository Security page for a private contact method and verify that it belongs
to this fork. If no verified private method is available, open a minimal public
issue asking the maintainer to establish private contact. Do not include the
vulnerability, reproduction steps, affected endpoint or secrets in that issue.

No response or remediation time is guaranteed until a monitored channel is
published.

## What to include privately

- affected release digest, tag or commit;
- deployment environment and architecture;
- minimal reproduction steps and required network position;
- impact and whether authentication is required;
- redacted logs or evidence;
- a proposed mitigation, if known.

Never send a real administrator password, session cookie, CSRF token, gateway
master key, Controller secret, SOCKS password, subscription URL, node share link
or encrypted state file. Replace each with an unmistakable placeholder.

## Security boundaries

- Web and Gateway API listen only on `127.0.0.1:8080`.
- Mihomo Controller listens only on `127.0.0.1:9090` and must never be exposed
  or reverse-proxied.
- Remote Web access uses a same-host HTTPS reverse proxy or an SSH tunnel.
- Only enabled ports within `10001`–`10010/tcp` are public SOCKS listeners.
- SOCKS username/password authentication does not encrypt transport. Restrict
  client source addresses where possible.
- UDP, IPv6 SOCKS and `DIRECT` fallback are disabled.
- Subscription and node inputs are untrusted configuration data and may contain
  credentials.

General defects that contain no security-sensitive detail may use the public
issue tracker for this fork.
