# MetaCubeXD SOCKS Gateway 部署指南

本指南适用于装有 OpenSSL 的 Linux 主机、Docker Engine 和 Docker Compose
v2。服务使用 host 网络：Web 固定监听 `127.0.0.1:8080`，Mihomo Controller 固定监听
`127.0.0.1:9090`，已启用的 SOCKS 端口监听 `10001`–`10010/tcp`。

## 安全拓扑

```text
管理浏览器 -> 同机 HTTPS 反向代理 -> 127.0.0.1:8080
          或 SSH 本地端口转发 -----^

Gateway Agent -> Mihomo Controller -> 127.0.0.1:9090
SOCKS 客户端 -> 10001–10010/tcp -> Mihomo -> 配置的节点
```

必须遵守以下边界：

- `9090` 只供本机 Agent 使用，绝不对公网、局域网、远程代理或浏览器开放，
  也不通过 Nginx/Caddy 转发。
- `8080` 保持回环监听。远程管理只能使用同机 HTTPS 反向代理或 SSH 隧道。
- 防火墙只放行实际启用的 SOCKS TCP 端口；不要放行对应 UDP。
- SOCKS5 用户名密码认证不加密客户端到网关的链路。尽可能限制客户端来源 IP，
  或在受信网络内使用。

## 首次启动

1. 克隆仓库并进入部署目录：

   ```sh
   git clone https://github.com/x1aodai/metacubexd-socks-gateway.git
   cd metacubexd-socks-gateway/deploy
   ```

2. 创建环境文件：

   ```sh
   cp .env.example .env
   ```

3. 编辑 `.env`，把镜像占位符替换为发行版公布的完整不可变 digest：

   ```dotenv
   GATEWAY_IMAGE=ghcr.io/x1aodai/metacubexd-socks-gateway@sha256:REPLACE_WITH_PUBLISHED_IMAGE_DIGEST
   TZ=Asia/Shanghai
   SESSION_COOKIE_SECURE=true
   ```

   不要使用 `latest`、裸 tag 或来源不明的镜像。

4. 生成本次部署专用的三项 secret：

   ```sh
   sh generate-secrets.sh
   ```

   脚本不会覆盖已有文件。管理员初始密码只显示一次，请立即保存到密码管理器。
   `gateway_master_key` 必须与加密数据一起备份；丢失后现有状态无法解密。

5. 启动并检查服务：

   ```sh
   docker compose pull
   docker compose up -d
   docker compose ps
   curl --fail http://127.0.0.1:8080/api/control/health
   ```

容器根文件系统只读，持久状态只写入 `gateway-data` volume，临时文件只写入
`/tmp`。服务不需要额外 capability，也不挂载 Docker Socket。

## 管理方式一：同机 HTTPS 反向代理

推荐在网关同一台主机运行 Nginx 或 Caddy。仓库提供：

- `deploy/nginx.conf.example`
- `deploy/Caddyfile.example`

替换示例域名和证书路径后启用配置。反向代理只把 HTTPS 请求转发到
`127.0.0.1:8080`。配置中不应出现 `9090` 或 Controller 路径。

防火墙通常只需允许：

```text
443/tcp                 管理域名
10001–10010/tcp 的子集  实际使用的 SOCKS 入口
```

保持 `.env` 中 `SESSION_COOKIE_SECURE=true`。不要通过额外 Docker 端口映射
发布 `8080`；它已经通过 host 网络绑定在宿主回环地址。

## 管理方式二：SSH 隧道

不配置公网管理域名时，可从操作电脑建立本地转发：

```sh
ssh -N -L 127.0.0.1:18080:127.0.0.1:8080 user@gateway-host
```

随后只在本机浏览器访问：

```text
http://127.0.0.1:18080
```

纯 HTTP 的隧道访问需要把 `.env` 改为：

```dotenv
SESSION_COOKIE_SECURE=false
```

然后执行 `docker compose up -d` 重新创建服务。HTTP 只存在于 SSH 加密隧道
两端的回环接口；不要在无 SSH 保护的网络上使用该设置。以后改回 HTTPS 管理时，
同时恢复 `SESSION_COOKIE_SECURE=true`。

## 首次使用

登录后固定进入“端口”页。建议按以下顺序配置：

1. 在“节点”页导入分享链接、Mihomo YAML 或订阅，预览后再应用。
2. 检测节点，需要时启用、停用或删除。删除前面板会显示受影响端口。
3. 在“账号”页创建 SOCKS 账号并绑定端口。密码只显示一次。
4. 在“端口”页编辑 `10001`–`10010`：绑定账号，选择一跳或两跳，并为每跳
   选择固定节点、自动最优或故障切换。
5. 保存并等待应用结果，再用 SOCKS 客户端连接相应端口。
6. 在“系统”页查看 Web、Agent、Mihomo、监听器和最近应用状态。

端口和跳数不会自动改变。固定节点失败时不会暗中换成其他节点。没有可用候选时
流量进入 `REJECT`，不会直接访问目标网络。

## 防火墙与运行态检查

只开放已启用端口的 TCP 入站规则，并按业务限制来源地址。不要添加 UDP 规则。
在主机检查监听状态：

```sh
ss -lnt | grep -E ':(8080|9090|1000[1-9]|10010)\b'
ss -lun | grep -E ':(1000[1-9]|10010)\b' && echo '发现意外 UDP 监听'
```

预期结果：

- `8080` 和 `9090` 只出现在 `127.0.0.1`；
- 只有已启用的 SOCKS 端口出现 TCP 监听；
- `10001`–`10010` 没有 UDP 监听。

## 日常运维

```sh
cd deploy
docker compose logs --tail=200 gateway
docker compose restart gateway
docker compose down
```

“系统”页的“重新应用”会用当前状态重新生成并验证配置。修改失败时系统恢复上一
运行版本；不要直接编辑 volume 中的加密文件或生成的 Mihomo 配置。

### 备份

停服务后同时备份：

- `gateway-data` Docker volume；
- `deploy/secrets/admin_password`；
- `deploy/secrets/gateway_master_key`；
- `deploy/secrets/clash_secret`；
- 当前 `.env` 中使用的镜像 digest。

备份应加密并限制权限。恢复时必须让原 `gateway_master_key` 与原 volume 配对。
不要用新密钥反复尝试打开旧状态。

### 升级

先备份，再把 `.env` 中的 `GATEWAY_IMAGE` 替换为目标发行版的新 digest：

```sh
docker compose pull
docker compose up -d
docker compose ps
```

确认登录、十个 Port Slot、账号绑定和运行状态仍正确后，再清理旧镜像。

## 从源码构建与 smoke

以下命令从仓库根目录运行；如果仍在 `deploy/` 目录，先执行 `cd ..`：

```sh
docker buildx build --load --platform linux/amd64 \
  -f apps/server/Dockerfile -t socks-gateway:mvp .
node deploy/verify-contract.mjs
node deploy/verify-distribution.mjs --image socks-gateway:mvp
bash deploy/smoke.sh --image socks-gateway:mvp --evidence ./smoke-evidence.jsonl
```

Smoke 使用随机 Compose 项目、临时 secret 和独立 volume，不读取真实部署 secret，
结束时会执行 `docker compose down -v --remove-orphans`。没有显式提供
`SMOKE_NODE_URL` 时，真实出口检查记为 `not-run`，基础安全与协议检查仍执行。

## 故障排查

### 无法登录

- HTTPS 反向代理场景确认 `SESSION_COOKIE_SECURE=true` 且浏览器使用 HTTPS。
- SSH 隧道的本地 HTTP 场景确认设置为 `false` 并已重新创建容器。
- 不要把管理员密码当作 SOCKS 密码；两者用途不同。

### 端口无法启用

- 检查该端口是否绑定至少一个启用账号；
- 检查每一跳是否仍有启用节点候选；
- 用 `ss -lnt` 检查固定端口是否被其他进程占用；
- 查看“系统”页最近应用的固定错误码和容器日志。

### 加密状态无法读取

优先恢复与该 volume 配套的原 `gateway_master_key`。在复制和备份现有 volume 前，
不要删除、重建或覆盖状态文件。

### 节点不可用

在“节点”页执行检测并检查订阅最近同步结果。订阅失败会保留最后一次有效节点；
网关仍然保持 fail closed，不应通过放宽 Controller 或启用直连来绕过问题。

## 许可

镜像包含 MetaCubeXD 派生代码和 Mihomo `v1.19.29`。分发自定义镜像时保留根
MIT 许可、`NOTICE`、Mihomo GPLv3 文本以及固定源码获取信息。详见
[`third_party/mihomo/SOURCE.md`](../third_party/mihomo/SOURCE.md)。
