# @metacubexd/agent manual smoke test

The Agent is the gateway runtime inside the all-in-one Server. It no longer
provides profile management, TUN, system proxy, WebDAV, kernel downloads, or a
standalone generic Mihomo API.

## Automated checks

Run from the repository root:

```bash
pnpm --filter @metacubexd/agent test
pnpm --filter @metacubexd/agent typecheck
pnpm --filter @metacubexd/server test
pnpm --filter @metacubexd/server typecheck
```

## Real local smoke test

This optional check starts a real Mihomo subprocess. Use a disposable data
directory, a Mihomo binary you already trust, and loopback-only management
bindings. Do not enable TUN or change the host system proxy.

Configure these Server variables before starting `@metacubexd/server`:

- `MIHOMO_BIN`: absolute path to the Mihomo binary;
- `DATA_DIR`: empty disposable directory;
- `ADMIN_PASSWORD`, `GATEWAY_MASTER_KEY`, and `CLASH_SECRET`: test-only values;
- `NITRO_HOST=127.0.0.1` and `NITRO_PORT=8080`.

Then verify:

1. `GET http://127.0.0.1:8080/api/control/health` returns `{"ok":true}`.
2. Login through the Web panel and confirm the System page reports Web, Agent,
   and Mihomo status.
3. The Ports page always contains slots `10001` through `10010`; disabled slots
   do not listen.
4. After adding a test node and credential, enable one slot and confirm only
   that authenticated TCP SOCKS5 listener becomes reachable.
5. Stop the Server and confirm the Mihomo child exits.

Delete only the disposable `DATA_DIR` after the process has stopped. This smoke
test does not authorize changes to a real VPS, firewall, system proxy, or TUN.
