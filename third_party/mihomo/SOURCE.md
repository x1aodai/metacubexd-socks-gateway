# Mihomo source and binary provenance

This distribution includes an unmodified Mihomo executable obtained from the
official MetaCubeX release.

## Fixed source revision

- Project: Mihomo
- Version: `v1.19.29`
- Commit: `e26714a181ac0e2fa803453c0a8e9a9ce94e31cb`
- Source tree:
  <https://github.com/MetaCubeX/mihomo/tree/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb>
- Source archive:
  <https://github.com/MetaCubeX/mihomo/archive/e26714a181ac0e2fa803453c0a8e9a9ce94e31cb.tar.gz>
- Release page: <https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.29>

To obtain the corresponding source with Git:

```sh
git clone https://github.com/MetaCubeX/mihomo.git
cd mihomo
git checkout --detach e26714a181ac0e2fa803453c0a8e9a9ce94e31cb
```

Use the build files and toolchain declarations from that exact checkout when
building Mihomo from source. Do not substitute a moving branch or a newer tag
when reproducing the bundled version.

## Container acquisition

This repository does not compile Mihomo in the container build. The `kernel`
stage in `apps/server/Dockerfile` downloads one official `v1.19.29` release
asset, verifies its SHA-256 checksum, decompresses it, and runs `mihomo -v`:

| Platform      | Official release asset                      | SHA-256                                                            |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `linux/amd64` | `mihomo-linux-amd64-compatible-v1.19.29.gz` | `5612e698e96c8b8ad15abc4c0a4f098eba9234354b4f248cb97f2528e215b094` |
| `linux/arm64` | `mihomo-linux-arm64-v1.19.29.gz`            | `9a868b5e4e0ad91d9d71e1b41b0cfce78aaba44360c30df74a723f8e3926a86c` |

The download base is:

```text
https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/
```

The copied license is the exact `LICENSE` file from tag `v1.19.29` and commit
`e26714a181ac0e2fa803453c0a8e9a9ce94e31cb`. Its SHA-256 is:

```text
3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986
```

Mihomo is licensed under GNU GPL version 3; see [LICENSE](./LICENSE).
