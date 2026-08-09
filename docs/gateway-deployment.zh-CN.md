# 固定 SOCKS5 网关部署指南

本分支在 MetaCubeXD Server 上增加了受管 SOCKS5 入口、单端口多账号、
节点与订阅导入、自动/故障转移出口、配置回滚和管理员登录。目标环境为
Debian/Ubuntu x86_64 与 Docker Compose v2。

## 网络结构

```text
公网 SOCKS 客户端 -> VPS:<1080-1099> -> Mihomo GATEWAY -> 上游节点
管理浏览器 -> 你的 HTTPS 反向代理 -> 127.0.0.1:8080
                                    -> /mihomo/* -> 127.0.0.1:9090
```

容器使用 host 网络，才能在面板修改 SOCKS 监听端口。8080 和 9090
仅绑定回环地址，不应在云安全组或主机防火墙中公开。

## 首次启动

```bash
git clone https://github.com/x1aodai/metacubexd-socks-gateway.git
cd metacubexd-socks-gateway/deploy
cp .env.example .env
sh generate-secrets.sh
docker compose pull
docker compose up -d
docker compose ps
```

默认从 GHCR 拉取适用于 `linux/amd64` 和 `linux/arm64` 的公开镜像：
`ghcr.io/x1aodai/metacubexd-socks-gateway:latest`。升级时执行：

```bash
cd metacubexd-socks-gateway/deploy
git pull --ff-only
docker compose pull
docker compose up -d
```

脚本只显示一次初始管理员密码，请立即保存。它不会覆盖已有 secrets。
所有运行数据保存在 Docker volume `gateway-data`，敏感文件的权限由应用
设置为 `0600`。

如需从源码构建而非拉取镜像：

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

默认可管理的 SOCKS 端口范围为 `1080-1099`。在云安全组中只放行实际
使用的 TCP 端口；确实需要 SOCKS UDP Associate 时，再放行同端口 UDP。
端口范围可在 `.env` 中调整，但必须同步修改防火墙规则。

## 反向代理

复制 `deploy/nginx.conf.example` 或 `deploy/Caddyfile.example` 并替换域名。
反向代理必须：

- 为面板提供 HTTPS；
- 将普通请求转发到 `127.0.0.1:8080`；
- 将 `/mihomo/*` 去除前缀后转发到 `127.0.0.1:9090`；
- 保留 WebSocket Upgrade；
- 先用 `/api/auth/check` 验证面板会话；
- 给 Mihomo 请求注入 `Authorization: Bearer <CLASH_SECRET>`。

Nginx 示例中的 `REPLACE_WITH_CLASH_SECRET` 应替换为
`deploy/secrets/clash_secret` 的内容。Caddy 示例从进程环境变量
`CLASH_SECRET` 读取同一值。不要把这个密钥提交到 Git。

反向代理完成后，浏览器会自动使用同源 `/mihomo` 端点，用户不需要看到
或填写 Controller 密钥。

## 使用流程

1. 使用初始化脚本显示的管理员密码登录。
2. 打开“SOCKS 网关”，创建至少一个 SOCKS 账号。
3. 导入订阅、粘贴分享链接或添加手动节点。
4. 选择 `MANUAL`、`AUTO` 或 `FAILOVER` 出口模式。
5. 启用网关，并使用面板显示的 VPS 地址、端口、用户名和密码连接。

没有可用节点时网关进入 `REJECT`，不会静默直连。修改端口或凭据会校验
候选配置并重新加载 Mihomo；仅切换节点不会重启内核。

## 运维与备份

```bash
cd deploy
docker compose logs -f gateway
docker compose exec gateway wget -qO- http://127.0.0.1:8080/api/control/health
docker compose down
```

备份时同时保存 `gateway-data` volume 和 `deploy/secrets`。缺少主密钥时，
加密的网关状态与历史版本无法恢复。升级前先备份；镜像内 Mihomo 固定为
`v1.19.29`，不要在面板内自动替换未知版本。

## 安全说明

- SOCKS5 用户名密码认证本身不加密。请使用生成的高熵密码，并尽可能在
  云安全组限制客户端来源 IP。
- 不要公开 8080、9090，不要挂载 Docker Socket，也不要关闭 HTTPS。
- 订阅 URL 和节点分享链接属于凭据，禁止写入公开日志、截图或仓库。
- 面板中的账号密码仅在创建或轮换时显示一次。
- 对外分发自定义镜像时，应保留 MetaCubeXD MIT 许可，并履行内置
  Mihomo GPLv3 对应源码与许可义务。
