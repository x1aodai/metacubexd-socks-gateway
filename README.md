# MetaCubeXD SOCKS Gateway

一个以快速可用为目标的自托管 SOCKS5 网关。项目沿用 MetaCubeXD 的现成代码，
但已经收敛为单容器、固定十端口和四页中文管理面板，不再提供通用 Mihomo
控制台。

## 核心能力

- 固定管理 `10001`–`10010` 十个 TCP SOCKS5 端口；停用的端口不会监听。
- 账号与端口多对多绑定，同一账号可用于多个端口，一个端口也可绑定多个账号。
- 节点可手动导入或来自订阅；节点可自由启用、停用和删除。
- 每个端口手动配置一跳或两跳；每一跳可选固定节点、自动最优或故障切换。
- 修改候选配置时先校验并事务应用，失败恢复上一版。
- 没有可用候选时拒绝连接，不会静默改为 `DIRECT`；UDP 和 IPv6 SOCKS 均关闭。
- 管理员登录、Session 与 CSRF 防护；SOCKS 密码只在创建或轮换时显示一次。

Web 面板只有四页：

| 页面 | 用途                                           |
| ---- | ---------------------------------------------- |
| 端口 | 编辑十个固定端口的账号、一跳/两跳和选路方式    |
| 节点 | 导入、检测、启停、删除节点及维护订阅           |
| 账号 | 创建、绑定、停用、删除和轮换 SOCKS 账号        |
| 系统 | 查看服务、版本、监听器、最近应用并执行重新应用 |

## 网络边界

```text
管理浏览器 -> 同机 HTTPS 反向代理或 SSH 隧道 -> 127.0.0.1:8080
内部 Agent -> Mihomo Controller                  -> 127.0.0.1:9090
SOCKS 客户端 -> 已启用的 10001–10010/tcp         -> Mihomo -> 节点
```

Web 和 Controller 固定绑定回环地址。`9090` 仅供容器内受管组件使用，绝不能
通过反向代理、端口转发、防火墙或安全组对外开放。远程管理只允许同机 TLS
反向代理或 SSH 隧道。详细步骤见
[中文部署指南](docs/gateway-deployment.zh-CN.md)。

## Docker 快速开始

部署前把镜像占位符替换为所选发行版公布的不可变 digest，不使用 `latest`：

```sh
git clone https://github.com/x1aodai/metacubexd-socks-gateway.git
cd metacubexd-socks-gateway/deploy
cp .env.example .env
# 编辑 .env，填写完整镜像地址和摘要，例如：
# GATEWAY_IMAGE=ghcr.io/x1aodai/metacubexd-socks-gateway@sha256:REPLACE_WITH_PUBLISHED_IMAGE_DIGEST
sh generate-secrets.sh
docker compose pull
docker compose up -d
```

初始化脚本只显示一次管理员密码，请立即保存。默认 `SESSION_COOKIE_SECURE=true`，
适用于同机 HTTPS 反向代理。使用 SSH 隧道访问本地 HTTP 时，按部署指南调整该项。

## 本地开发

需要 [`.node-version`](.node-version) 锁定的 Node.js、Corepack 和仓库锁定的
pnpm 版本：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

网关契约与分发归属可分别检查：

```sh
node deploy/verify-contract.mjs
node deploy/verify-distribution.mjs
```

真实容器 smoke 只在 Linux Docker 主机执行，并使用本地镜像：

```sh
bash deploy/smoke.sh --image socks-gateway:mvp --evidence ./smoke-evidence.jsonl
```

## 许可与来源

- MetaCubeXD 派生代码沿用根目录 [MIT LICENSE](LICENSE)。
- 分支和基线归属见 [NOTICE](NOTICE)。
- 容器内 Mihomo `v1.19.29` 使用 GPLv3；许可与固定源码信息见
  [`third_party/mihomo`](third_party/mihomo/SOURCE.md)。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题处理边界见
[Security Policy](.github/SECURITY.md)。
