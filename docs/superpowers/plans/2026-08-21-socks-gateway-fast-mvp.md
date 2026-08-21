# SOCKS Gateway 快速可用 MVP 实施计划

## 1. 目标与依据

**目标：** 在 `metacubexd-socks-gateway` 现有 all-in-one 服务端上交付固定 10 个
SOCKS5 端口、账号多对多授权、全局节点库、单跳/双跳和每跳三种策略，并把 Web 收敛为
端口、节点、账号、系统四个入口。

**设计依据：**
`docs/superpowers/specs/2026-08-21-socks-gateway-fast-mvp-design.md`

**基线：** `b69d26fe`；设计分支：`codex/fast-mvp-design`。

**技术栈：** TypeScript 6、Node.js 22、pnpm 10、Vitest、Nuxt 4、Vue 3、Nitro、
Mihomo、Docker Compose。

本环境没有安装设计流程指定的 `writing-plans` skill。本计划按同一要求手工编写，仍坚持准确
文件路径、增量 TDD、每个切片独立验证和小提交。

## 2. 执行规则

1. 每个代码任务先添加失败测试并记录预期 RED，再写最小实现得到 GREEN。
2. 只提交当前任务文件；不得混入相邻清理或格式化。
3. 每个任务至少运行其目标测试和目标包 typecheck。
4. 完成一个里程碑后运行 `ponytail-review`，只检查自上次审查后的增量，不自动扩大审查范围。
5. `pnpm lint` 在改造前会自动写文件；脚本修正前只使用
   `pnpm --filter @metacubexd/ui exec eslint .` 做只读检查。
6. 宿主防火墙、系统代理、TUN、真实 VPS 和生产发布不在本地实施授权内。相关实机门禁只记
   `pass`、`fail` 或 `not-run`。
7. 停用端口允许 `hops=[]`；启用端口严格要求 1–2 跳、至少一个启用账号。
8. 不增加数据库、微服务、插件系统、通用 repository/service 层或兼容旧 UI 的长期分支。

## 3. 最终 API 契约

实现前先锁定以下同源路径，前后端不保留重复的 v1 别名：

```text
GET    /api/control/gateway/ports
PUT    /api/control/gateway/ports/:id

GET    /api/control/gateway/nodes
PUT    /api/control/gateway/nodes/:id
POST   /api/control/gateway/nodes/:id/test
GET    /api/control/gateway/nodes/:id/impact
DELETE /api/control/gateway/nodes/:id        body: { confirmed: boolean }

POST   /api/control/gateway/imports/preview
POST   /api/control/gateway/imports/apply

GET    /api/control/gateway/subscriptions
POST   /api/control/gateway/subscriptions
PUT    /api/control/gateway/subscriptions/:id
DELETE /api/control/gateway/subscriptions/:id
POST   /api/control/gateway/subscriptions/:id/sync
POST   /api/control/gateway/subscriptions/refresh

GET    /api/control/gateway/credentials
POST   /api/control/gateway/credentials
PUT    /api/control/gateway/credentials/:id
DELETE /api/control/gateway/credentials/:id
POST   /api/control/gateway/credentials/:id/rotate

GET    /api/control/gateway/status
POST   /api/control/gateway/reapply
GET    /api/control/gateway/revisions
```

手工添加单个节点复用 imports preview/apply，传入只包含一个节点的分享链接、Mihomo YAML 或
JSON，不再单独设计协议特定表单。节点删除 409 响应只允许返回 `affectedPortIds`，不得返回原始
proxy 或订阅 URL。

## 4. 里程碑 A：后端领域闭环

### Task 0：建立可重复基线

**修改文件：** 无。

1. 确认 `git status --short` 为空并记录 `node --version`、`corepack pnpm --version`。
2. 运行 `corepack pnpm install --frozen-lockfile`。
3. 运行现有基线：

   ```powershell
   pnpm --filter @metacubexd/agent test
   pnpm --filter @metacubexd/agent typecheck
   pnpm --filter @metacubexd/server test
   pnpm --filter @metacubexd/server typecheck
   pnpm --filter @metacubexd/ui test:unit
   pnpm --filter @metacubexd/ui typecheck
   pnpm build
   ```

4. 若基线失败，只记录与目标功能无关的既有失败；不得在后续任务中顺手修复。

### Task 1：版本 2 状态模型与纯迁移

**新增文件：**

- `packages/agent/src/gateway-state.ts`
- `packages/agent/src/gateway-state.test.ts`

**修改文件：**

- `packages/agent/src/gateway.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/index.test.ts`

**RED：** 先写测试覆盖固定 `10001–10010`、停用端口 `hops=[]`、启用端口约束、三种模式、
未知节点、连续同节点拒绝和 v1→v2 映射。迁移测试必须证明原 v1 的全部启用账号绑定到
`10001`，停用账号保留但不自动绑定。

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-state.test.ts
```

**实现：**

- 定义 `GatewayStateV1 | GatewayStateV2`、`GatewayPort`、`GatewayHop`、`StoredNode` 和固定端口常量；
- 初始 v2 生成 10 个停用端口；
- `manual` 恰好一个节点，`auto/failover` 至少一个节点；
- 纯 `migrateV1ToV2()` 保留账号、节点源、订阅关联、修订和最近结果；
- v1 单端口映射到 `10001`，其余九个端口停用；
- 复用 `subscription/parse.ts` 的 `stableNodeId()`，不再以显示名称作为引用；
- 已启用的 v1 路由若无法解析为稳定节点 ID，迁移必须报错；bootstrap 保持 v1 原始文件不变并
  停止启动。只有原本停用的 v1 网关可以迁成停用的 `10001`，不能用静默停用掩盖迁移失败。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-state.test.ts src/index.test.ts
pnpm --filter @metacubexd/agent typecheck
```

**提交：** `feat(agent): add gateway v2 state model`

### Task 2：确定性单跳与 10 listener 生成器

**新增文件：**

- `packages/agent/src/gateway-config.ts`
- `packages/agent/src/gateway-config.test.ts`

**修改文件：**

- `packages/agent/src/gateway.ts`
- `packages/agent/src/gateway.test.ts`

**RED：** 测试 10 个端口、端口专属用户、固定/自动最优/故障切换、禁用端口不监听、无 UDP、
无匿名和完整 YAML 无 `DIRECT`；额外放入带旧规则、旧 group 和外部 `dialer-proxy` 的恶意 base/
节点夹具，断言生成器删除或拒绝它们。

**实现：** 把现有 `overlay()` 抽成纯生成器，固定命名：

```text
listener: gateway-socks-10001
group:    GW-10001-H1
group:    GW-10001-H2
derived:  GW-10001-H2-node_<stable-id>
```

- `manual → select`、`auto → url-test`、`failover → fallback`；
- listener 固定 `type: socks`、`listen: 0.0.0.0`、`udp: false`；
- listener 只包含当前端口绑定且启用的账号；
- 从最小配置重新生成全部 listener、proxy group、rule 和代理入口，不保留 base config 中任何旧
  路由对象；导入节点只保留协议连接字段，拒绝外部 `dialer-proxy` 等路由控制字段；
- 对最终对象再做 fail-closed 深度校验，任何用户输入产生的 `DIRECT` 引用或未受管路由对象均
  使应用失败；
- 防御性兜底只允许 `REJECT`。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-config.test.ts src/gateway.test.ts
pnpm --filter @metacubexd/agent typecheck
```

**提交：** `feat(agent): generate isolated gateway listeners`

### Task 3：双跳 `dialer-proxy`

**修改文件：**

- `packages/agent/src/gateway-config.ts`
- `packages/agent/src/gateway-config.test.ts`

**RED：** 测试三种模式任意组合、落地派生代理、前置组引用、原节点不被修改、同节点跨端口复用、
同链路连续同节点拒绝以及一个端口变化不改变其他端口输出。

**实现：**

- 双跳只克隆落地候选；
- 每个派生落地代理增加 `dialer-proxy: GW-<port>-H1`；
- listener 指向该端口的 H2 group；
- 单跳 listener 直接指向 H1；
- 所有派生名称包含端口和稳定节点 ID，避免碰撞。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-config.test.ts
pnpm --filter @metacubexd/agent typecheck
```

**提交：** `feat(agent): support two-hop gateway routes`

**里程碑审查：** 对 Task 1–3 增量运行 `ponytail-review`；重点检查重复模型、无用兼容层和生成器
中的策略抽象。通过后再进入事务代码。

### Task 4：真正事务式应用、启动迁移与回滚

**新增文件：**

- `packages/agent/src/gateway-apply.test.ts`

**修改文件：**

- `packages/agent/src/gateway.ts`

本任务复用 `secure-store.ts` 已有的原子写入与权限收紧工具，不修改其公共接口；v1 备份、
候选状态和 revision 清理由 `gateway.ts` 内的现有文件系统原语完成。

**RED：** 覆盖校验失败、restart 失败、listener 验证失败、并发 mutation、孤儿 revision 清理、
v1 备份幂等和进程重启期间读取候选状态。

**实现顺序：**

1. clone candidate；
2. 业务校验和 YAML 生成；
3. 写临时候选并执行 `mihomo -t`；
4. snapshot 当前活动状态；
5. 设置仅 apply 期间可见的 `pendingState`；
6. restart，让 supervisor 的第二次 `configTransform` 优先读取 `pendingState`；
7. 验证 Controller 和全部启用 listener；
8. 成功后才持久化 v2 并清除 `pendingState`；
9. 失败时先清除 `pendingState`，再恢复旧 active、旧状态并重启旧进程，最后删除失败 revision。

为测试 10 个固定端口，在 `GatewayManagerOptions` 增加窄的 `verifyListener` seam；生产默认仍执行
真实 SOCKS 用户名/密码握手。

v1 文件先备份为 `gateway.enc.v1.bak`，权限 `0600`。迁移验证失败时保留原始密文字节并终止
gateway bootstrap。

`gateway.bootstrap()` 统一拥有首次启动、v1 迁移和普通 v2 恢复：它在内部完成候选校验、
Supervisor start/restart、运行验证以及成功后的状态提交。调用方不得在 bootstrap 后再次启动
Supervisor。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-apply.test.ts src/gateway.test.ts
pnpm --filter @metacubexd/agent typecheck
```

**提交：** `fix(agent): apply gateway state transactionally`

### Task 5：端口和账号多对多 CRUD

**新增文件：**

- `packages/agent/src/gateway-ports.test.ts`

**修改文件：**

- `packages/agent/src/gateway.ts`
- `packages/agent/src/gateway-state.ts`

**RED：** 覆盖 10 项固定返回、同账号多端口、同端口多账号、停用账号保留绑定、删除账号清理
全部引用，以及失去最后一个启用账号时端口自动停用。

**实现：**

- `listPorts()`；
- `updatePort(id, { enabled, credentialIds, hops })`；
- credential 响应派生 `portIds`；
- credential create/update 接受 `portIds`；
- 删除账号后一次事务更新所有受影响端口；
- 不允许修改端口号或创建第 11 个端口。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-ports.test.ts
pnpm --filter @metacubexd/agent typecheck
```

**提交：** `feat(agent): bind credentials to gateway ports`

### Task 6：稳定节点库、订阅排除项和确认删除

**新增文件：**

- `packages/agent/src/gateway-nodes.test.ts`

**修改文件：**

- `packages/agent/src/gateway.ts`
- `packages/agent/src/gateway-state.ts`
- `packages/agent/src/gateway-subscriptions.ts`
- `packages/agent/src/gateway-subscriptions.test.ts`

**RED：** 覆盖导入后稳定 ID、重命名不丢引用、禁用节点、单节点检测、订阅刷新排除、全部订阅
刷新、删除影响 409、确认删除后池缩减、双跳变单跳和无跳点停用。

**实现：**

- `appendImportedNodes` 和 `replaceNodeSource` 接受 `NormalizedNode[]`；
- source bucket 保存 `{ nodes, excludedNodeIds }`；
- 节点 DTO 不返回 raw proxy；
- `nodeImpact(id)` 返回引用端口 ID；
- `testNode(id)` 通过 Controller delay API 检测受管节点，只返回 `reachable`、可用时的
  `latencyMs` 和白名单错误码；
- `refreshSubscriptions()` 获取全部启用订阅，成功项在同一个候选状态中合并应用，失败项保留
  旧节点并返回逐项脱敏结果，不因一个 URL 失败删除其他订阅节点；
- 未确认的在用节点删除返回 409 和白名单 details；
- 确认删除后从所有 hop 移除，空 hop 删除，无 hop 时端口停用；
- 订阅节点删除写 exclusion，显式重新导入/恢复同 ID 才清 exclusion；
- Controller 离线时仍从持久化状态列出节点。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-nodes.test.ts src/gateway-subscriptions.test.ts
pnpm --filter @metacubexd/agent typecheck
```

**提交：** `feat(agent): manage stable gateway nodes`

### Task 7：逐端口状态，固定模式不自动切换

**新增文件：**

- `packages/agent/src/gateway-status.test.ts`

**修改文件：**

- `packages/agent/src/gateway.ts`

**RED：** 连续多次查询不健康 manual 节点，断言 mode、node IDs、hop 数和密文状态文件完全不变；
同时覆盖逐端口 active node、10 个 listener 错误隔离、最近应用结果、Web/Agent/Mihomo 服务状态、
三者版本字段和 DTO 脱敏。

**实现：**

- 删除 `manualHealthFailures` 和 status 中的持久化/切换；
- 一次读取 Controller `/proxies` 后映射每个端口、每一跳；
- 一个 listener 失败只标记对应端口；
- manager 返回 Agent、Mihomo、10 个 listener、端口链路和 `lastApply`；Server 在同一路径补充 Web
  状态与版本，最终 DTO 固定为 `services`、`versions`、`listeners`、`ports`、`lastApply`；
- 响应不含 proxy 原文、密码、URL、Controller secret 或完整配置。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/gateway-status.test.ts
pnpm --filter @metacubexd/agent typecheck
```

**提交：** `fix(agent): report gateway health without mutation`

### Task 8：收敛 Gateway HTTP API 与 Server 认证集成

**修改文件：**

- `packages/agent/src/http.ts`
- `packages/agent/src/http.test.ts`
- `apps/server/routes/api/control/[...].ts`
- `apps/server/routes/__tests__/auth.spec.ts`

**新增文件：**

- `apps/server/routes/__tests__/gateway.spec.ts`

**RED：** 先锁定第 3 节全部路径、method、body、409 details、一次性密码、URL 脱敏、Cookie、
CSRF 和并发 PUT，并覆盖节点检测、全量订阅刷新以及 Server 对 status 的 Web 状态/版本聚合。

**实现：**

- 把 imports、subscriptions、credentials、revisions 全部收进 gateway 前缀；
- `GatewayValidationError` 只允许白名单 details；
- create/rotate 之外不返回密码；
- 删除 audit、runtime config 和旧 outbound API；
- 暂留的 kernel status 必须删除 secret 字段；
- Agent router 测路由映射，Server 测真实 session Cookie + CSRF。

**GREEN：**

```powershell
pnpm --filter @metacubexd/agent exec vitest run src/http.test.ts
pnpm --filter @metacubexd/server exec vitest run routes/__tests__/gateway.spec.ts routes/__tests__/auth.spec.ts
pnpm --filter @metacubexd/agent typecheck
pnpm --filter @metacubexd/server typecheck
```

**提交：** `feat(server): expose gateway v2 API`

### Task 9：安全启动与固定端口接线

**修改文件：**

- `apps/server/lib/supervisor.ts`
- `apps/server/lib/__tests__/supervisor.spec.ts`
- `apps/server/plugins/boot-kernel.ts`

**新增文件：**

- `apps/server/plugins/__tests__/boot-kernel.spec.ts`

**RED：** 覆盖固定 Controller、无端口范围环境变量、bootstrap 失败停止启动、关闭资源和没有
manual failover timer。

**实现：**

- Gateway 不再接收 `defaultPort/minPort/maxPort`；
- Controller 固定 `127.0.0.1:9090`；
- boot 只等待 `gateway.bootstrap()`；bootstrap 自己完成 initialize/migration、Mihomo start/restart 和
  运行验证，plugin 不再额外调用 `supervisor.start()`；
- 删除通用 profile scheduler 和每分钟 `gateway.status()` timer；
- 保留 gateway subscription scheduler；
- close hook 停 scheduler 并 dispose supervisor。

**GREEN：**

```powershell
pnpm --filter @metacubexd/server exec vitest run lib/__tests__/supervisor.spec.ts plugins/__tests__/boot-kernel.spec.ts
pnpm --filter @metacubexd/server test
pnpm --filter @metacubexd/server typecheck
pnpm --filter @metacubexd/server build
```

**提交：** `fix(server): bootstrap the fixed-port gateway safely`

**里程碑 A 验证：**

```powershell
pnpm --filter @metacubexd/agent test
pnpm --filter @metacubexd/agent typecheck
pnpm --filter @metacubexd/server test
pnpm --filter @metacubexd/server typecheck
```

运行 Task 4–9 增量的 `ponytail-review`。通过后后端达到本地 API 闭环。

## 5. 里程碑 B：极简 Web 可操作闭环

### Task 10：前端 v2 DTO、API 客户端和端口表单逻辑

**新增文件：**

- `packages/ui/composables/usePortEditor.ts`
- `packages/ui/composables/__tests__/usePortEditor.spec.ts`
- `packages/ui/composables/__tests__/useGatewayAuth.spec.ts`

**修改文件：**

- `packages/ui/types/gateway.ts`
- `packages/ui/composables/useGatewayApi.ts`
- `packages/ui/composables/useGatewayAuth.ts`
- `packages/ui/composables/__tests__/useGatewayApi.spec.ts`

**RED：** 锁定全部 v2 DTO 和 API method/body/CSRF；端口编辑器覆盖 0/1/2 跳、三模式、manual
单节点、failover 排序、连续同节点拒绝和链路预览不修改原对象；认证网络失败必须 fail closed。

**实现：**

- 删除 v1 `GatewayConfig`、全局 outbound、`selectedNode` 和 `udp`；
- API 只调用第 3 节路径；
- `usePortEditor` 只负责本地草稿和校验，不创建全局 store；
- auth 删除静态 panel/desktop 的 `unavailable` 降级。

**GREEN：**

```powershell
pnpm --filter @metacubexd/ui exec vitest run composables/__tests__/useGatewayApi.spec.ts composables/__tests__/useGatewayAuth.spec.ts composables/__tests__/usePortEditor.spec.ts
pnpm --filter @metacubexd/ui typecheck
```

**提交：** `feat(ui): add gateway v2 client contracts`

### Task 11：最小导航、登录和端口页

**新增文件：**

- `packages/ui/pages/ports.vue`
- `packages/ui/components/gateway/PortEditor.vue`
- `packages/ui/components/gateway/HopEditor.vue`
- `packages/ui/components/gateway/StatusBadge.vue`
- `packages/ui/components/gateway/__tests__/PortEditor.spec.ts`
- `packages/ui/components/gateway/__tests__/HopEditor.spec.ts`
- `packages/ui/components/gateway/__tests__/GatewayNavigation.spec.ts`

**修改文件：**

- `packages/ui/pages/index.vue`
- `packages/ui/pages/login.vue`
- `packages/ui/middleware/auth.global.ts`
- `packages/ui/components/Sidebar.vue`
- `packages/ui/components/LogoText.vue`
- `packages/ui/components/Button.vue`
- `packages/ui/components/Modal.vue`
- `packages/ui/layouts/default.vue`
- `packages/ui/layouts/blank.vue`
- `packages/ui/app.vue`
- `packages/ui/vitest.config.ts`
- `packages/ui/package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`

**RED：** 增加 SFC 测试并锁定四项导航、10 行固定端口、编辑 1/2 跳、确认保存、内联成功/失败和
卸载后停止轮询。测试依赖只增加固定版本 `@vitejs/plugin-vue 6.0.8` 与
`@vue/test-utils 2.4.6`。

**实现：**

- 根路径和登录成功固定进入 `/ports`；
- auth middleware 只公开 `/login`；
- Sidebar 只显示端口、节点、账号、系统和退出；
- 移动端在同一 Sidebar 内显示四项横向导航；
- ports 页每 5 秒读取状态，组件卸载即清 timer；
- 表单确认后直接事务式 PUT，不增加服务端草稿；
- Button 与 Modal 删除旋转、缩放和弹性过渡，同时保留清晰的键盘焦点和关闭行为；
- 固定中文、浅色、无 toast-only 反馈和无动画依赖。

**GREEN：**

```powershell
pnpm --filter @metacubexd/ui exec vitest run components/gateway/__tests__/PortEditor.spec.ts components/gateway/__tests__/HopEditor.spec.ts components/gateway/__tests__/GatewayNavigation.spec.ts
pnpm --filter @metacubexd/ui typecheck
pnpm --filter @metacubexd/ui generate
```

**提交：** `feat(ui): add the fixed-port gateway console`

### Task 12：节点、账号和系统页

**新增文件：**

- `packages/ui/pages/nodes.vue`
- `packages/ui/pages/credentials.vue`
- `packages/ui/pages/system.vue`
- `packages/ui/components/gateway/NodeImportDialog.vue`
- `packages/ui/components/gateway/CredentialSecretDialog.vue`
- `packages/ui/components/gateway/ConfirmImpactDialog.vue`
- `packages/ui/components/gateway/SubscriptionEditor.vue`
- `packages/ui/components/gateway/__tests__/NodeImportDialog.spec.ts`
- `packages/ui/components/gateway/__tests__/CredentialSecretDialog.spec.ts`
- `packages/ui/pages/__tests__/nodes.spec.ts`
- `packages/ui/pages/__tests__/credentials.spec.ts`
- `packages/ui/pages/__tests__/system.spec.ts`

**修改文件：**

- `packages/ui/components/Sidebar.vue`
- `packages/ui/composables/useGatewayApi.ts`

**RED：** 覆盖导入预览、节点检测/启停/批量删除、订阅创建/编辑/删除/单项刷新、账号端口多选与
停用/删除/轮换、密码只显示一次、系统重新应用、刷新全部订阅、管理员密码修改和版本信息。
三个页面级测试分别锁定节点、账号和系统流程，不能只靠 E2E 替代组件测试。

**实现：**

- nodes 只使用 Gateway nodes/status，不再调用 Proxies store；
- 批量删除先并行读取所选节点 impact，显示受影响端口并一次确认，再按稳定 ID 顺序调用既有单节点
  confirmed DELETE；逐项报告成功/失败，不新增第二套批量 API；
- subscriptions 在节点页内完成创建、编辑、删除、单项同步，系统页调用全量刷新；
- credential 页面用端口多选维护 `portIds`；
- credential 页面提供停用、删除和轮换，删除前显示受影响端口；
- secret dialog 关闭后销毁内存中的密码；
- system 只显示 Web/Agent/Mihomo/listener 状态、三者版本、最近结果、重新应用、刷新全部订阅和
  密码修改；
- revisions 只读最近结果，不恢复 audit 或人工历史浏览器。

**GREEN：**

```powershell
pnpm --filter @metacubexd/ui test:unit
pnpm --filter @metacubexd/ui typecheck
pnpm --filter @metacubexd/ui generate
```

**提交：** `feat(ui): add gateway resource pages`

### Task 13：替换 E2E 为四个核心流程

**删除文件：**

- `packages/ui/e2e/pages.spec.ts`

**新增文件：**

- `packages/ui/e2e/gateway.spec.ts`

**修改文件：**

- `packages/ui/nuxt.config.ts`（只保留测试所需的安全 mock 注入）

**覆盖：** 未登录重定向、登录后端口页、10 端口、单/双跳保存；节点导入、检测、启停、订阅
增删改/刷新和批量删除确认；账号创建、绑定、停用、删除、轮换与密码一次显示；系统版本、
重新应用、刷新全部订阅、修改管理员密码，以及四项导航之外没有旧入口。

```powershell
pnpm --filter @metacubexd/ui build:mock
pnpm --filter @metacubexd/ui test:e2e
```

**提交：** `test(ui): cover gateway management flows`

**快速可用检查点：** Task 13 结束后运行 agent/server/UI 全部测试和 build。此时应先向用户报告
“本地可操作 MVP”，再进入删除旧产品面的清理；不得把尚未运行的 Docker/VPS 验收报告为通过。

运行 Task 10–13 增量的 `ponytail-review`。

## 6. 里程碑 C：删除冗余运行面

### Task 14：收敛 Agent 与 Server 为 gateway-only

**修改文件：**

- `packages/agent/src/index.ts`
- `packages/agent/src/index.test.ts`
- `packages/agent/src/http.ts`
- `packages/agent/src/http.test.ts`
- `packages/agent/src/types.ts`
- `packages/agent/package.json`
- `packages/agent/MANUAL.md`
- `apps/server/lib/supervisor.ts`
- `apps/server/plugins/boot-kernel.ts`
- `apps/server/nitro.config.ts`

**删除文件：**

- `packages/agent/src/merge.ts` 及其测试
- `packages/agent/src/profile-editor.ts` 及其测试
- `packages/agent/src/profiles.ts` 及其测试
- `packages/agent/src/refresh-apply.ts` 及其测试
- `packages/agent/src/scheduler.ts` 及其测试
- `packages/agent/src/script.ts` 及其测试
- `packages/agent/src/tun.ts` 及其测试
- `packages/agent/src/webdav.ts` 及其测试
- `packages/agent/src/kernel/fetch-kernel.ts` 及其测试
- `packages/agent/src/kernel/fetch-wintun.ts` 及其测试
- `packages/agent/src/kernel/geo.ts` 及其测试
- `packages/agent/src/kernel/unzip-entry.ts`
- `apps/server/routes/config.js.ts` 及对应测试

保留 `supervisor.ts`、`secure-store.ts`、gateway 文件、subscription parser、admin auth 和固定
Mihomo version asset。`createAgent()` 直接组装 supervisor、gateway、subscriptions 和 gateway router，
不增加第二个工厂。

先写/修改 `index.test.ts` 与 `http.test.ts`，断言 feature 集合和路由面只包含 gateway 所需能力，
再断引用、删除源文件和依赖。

```powershell
pnpm --filter @metacubexd/agent test
pnpm --filter @metacubexd/agent typecheck
pnpm --filter @metacubexd/server test
pnpm --filter @metacubexd/server typecheck
```

**提交：** `refactor(agent): remove generic mihomo control features`

### Task 15：删除旧 UI、桌面端和多形态依赖

**先修改：**

- `packages/ui/nuxt.config.ts`
- `packages/ui/package.json`
- `packages/ui/test/setup.ts`
- `packages/ui/assets/css/main.css`
- 根 `package.json`
- `pnpm-workspace.yaml`
- `.github/workflows/unit-tests.yml`
- `.github/workflows/release.yml`
- `release-please-config.json`
- `.dockerignore`

**删除页面：**

- `packages/ui/pages/gateway.vue`
- `config.vue`、`connections.vue`、`control.vue`、`logs.vue`、`overview.vue`、`profiles.vue`、
  `profiles/[id]/edit.vue`、`proxies.vue`、`rules.vue`、`setup.vue`、`traffic.vue`

**删除目录或文件组：**

- `packages/ui/components/connections/`
- `packages/ui/components/config-editor/`
- 除 `Button.vue`、`Modal.vue`、`LogoText.vue`、`Sidebar.vue` 和 `components/gateway/` 外的旧组件
- 除 `useGatewayApi.ts`、`useGatewayAuth.ts`、`usePortEditor.ts` 外的旧 composables
- `packages/ui/composables/index.ts`
- `packages/ui/stores/`
- `packages/ui/types/control.ts`、`types/index.ts`、`types/network.ts`
- 除 `utils/controlError.ts` 及其测试外的旧 utils
- `packages/ui/constants/`、`plugins/`、`i18n/`、`assets/fonts/`、`scripts/screenshot.ts`
- `packages/ui/__tests__/locales.spec.ts`、`packages/ui/__tests__/docker-entrypoint.spec.ts`
- `apps/desktop/`
- `packages/config-editor/`
- `Casks/`
- `packages/ui/Dockerfile`、`packages/ui/docker-entrypoint.sh`

**依赖处理：**

- 删除 Electron、Monaco、WebDAV、PWA、i18n、Pinia、Vue Query、VueUse、图表、主题、markdown、
  QR、sortable 和旧 proxy UI 依赖；
- 保留 Nuxt、Vue、Vue Router、ky、Tabler icons、Tailwind、DaisyUI、Vitest、Playwright 和必要测试依赖；
- `packages/ui` 的 `lint` 改为 `eslint .`，新增 `lint:fix`；
- 根脚本增加聚合 `test`，删除 desktop/static-panel 脚本；
- 用 `pnpm install --lockfile-only` 重新生成 lockfile，不手改锁文件。

每批删除前后运行 `rg` 检查 Nuxt auto-import 残余引用，再运行：

```powershell
pnpm test
pnpm typecheck
pnpm --filter @metacubexd/ui exec eslint .
pnpm build
```

**提交：** `refactor: remove desktop and generic dashboard`

**里程碑审查：** 对 Task 14–15 增量运行 `ponytail-review`，验证没有为了删除旧代码而新增等量
兼容层或无用包装。

## 7. 里程碑 D：部署、许可和最终门禁

### Task 16：固定部署面与安全容器

**修改文件：**

- `apps/server/Dockerfile`
- `apps/server/docker-entrypoint.sh`
- `deploy/compose.yaml`
- `deploy/compose.build.yaml`
- `deploy/.env.example`
- `deploy/generate-secrets.sh`
- `deploy/nginx.conf.example`
- `deploy/Caddyfile.example`
- `apps/server/lib/__tests__/supervisor.spec.ts`
- `packages/agent/src/kernel/assets.ts`
- `.github/workflows/publish-container.yml`
- `.github/workflows/release.yml`

**新增文件：**

- `deploy/verify-contract.mjs`
- `deploy/smoke.sh`
- `deploy/smoke-gateway.mjs`

**删除文件：**

- `apps/server/compose.yaml`
- `docs/docker-compose.yml`
- `docs/config.yaml`
- `deploy/public.env.example`
- `deploy/waf.env.example`
- `deploy/nginx.remote-waf.conf.example`

**测试先行的部署契约：**

- Web 固定回环 `127.0.0.1:8080`；
- Controller 固定回环 `127.0.0.1:9090`；
- 只允许 `10001–10010/tcp` SOCKS listener；
- 删除 `MIXED_PORT`、`SOCKS_PORT_MIN/MAX`、可变 Controller bind/CORS、公开 direct mode 和 control token；
- Compose 仍只有一个 host-network service 和一个数据 volume；
- 增加 `cap_drop: [ALL]`、`read_only: true`、`no-new-privileges`，写入仅限 `/data` 和 `/tmp`；
- Dockerfile、agent asset 和发布 workflow 使用同一个固定 Mihomo 版本。

`verify-contract.mjs` 用 Node 标准库静态检查以上约束及版本一致性。`smoke.sh` 使用 `mktemp`、
随机 Compose project name 和 trap 清理，生成本次测试专用的三项 secrets 后启动指定镜像；
`smoke-gateway.mjs` 完成管理员 bootstrap/session/CSRF、导入不可达的本地测试节点、创建并绑定
测试账号、启用全部 `10001–10010`、逐端口 SOCKS 认证握手并确认没有对应 UDP socket；同时验证
错误账号、未绑定账号和匿名请求均被拒绝，重启后 10 端口状态保持，故障配置触发上一版回滚，
不可达候选的 CONNECT 失败而不会直连。脚本不得读取或覆盖真实部署 secrets；需要真实出口的
项目通过显式 `SMOKE_NODE_URL` 才运行，否则记为 `not-run`。

```powershell
node deploy/verify-contract.mjs
docker compose -f deploy/compose.yaml -f deploy/compose.build.yaml config --quiet
docker buildx build --load --platform linux/amd64 -f apps/server/Dockerfile -t socks-gateway:mvp .
```

在 Linux + Docker 可用时再运行 `bash deploy/smoke.sh --image socks-gateway:mvp`；脚本把每项结果
以 `pass`、`fail`、`not-run` 写入临时 evidence 文件，并在退出时执行 canonical Compose down。

**提交：** `build: lock down the gateway container`

### Task 17：部署文档、来源归属和 CI

**新增文件：**

- `NOTICE`
- `third_party/mihomo/LICENSE`
- `third_party/mihomo/SOURCE.md`
- `deploy/verify-distribution.mjs`

**修改文件：**

- `README.md`
- `CONTEXT.md`
- `CONTRIBUTING.md`
- `.github/SECURITY.md`
- `.github/copilot-instructions.md`
- `.github/workflows/unit-tests.yml`
- `.github/workflows/e2e.yml`
- `.github/workflows/publish-container.yml`
- `.github/workflows/release.yml`
- `docs/gateway-deployment.zh-CN.md`
- `packages/ui/PRODUCT.md`
- `packages/ui/DESIGN.md`
- `apps/server/Dockerfile`

**要求：**

- 根 `LICENSE` 中 MetaCubeX MIT 声明原样保留；
- NOTICE 说明 MetaCubeXD 上游、当前 fork 和基线；
- Mihomo 许可文本与固定 tag 完全匹配，SOURCE 提供对应源码地址和构建/获取说明；
- Docker 镜像把三类许可/NOTICE 复制到 `/usr/share/licenses` 或 `/usr/share/doc`；
- README 只描述 gateway-only 产品和四页流程；
- 部署文档只允许同机 Nginx/Caddy 或 SSH tunnel 访问 Web，不公开 9090；
- unit workflow 运行 root test/typecheck/lint/build，不再运行 desktop；
- release workflow 只保留 release-please，GHCR 镜像只由 publish-container 发布；
- publish 前执行质量门禁并保留 SBOM。

`verify-distribution.mjs` 检查根 MIT 声明未被改写、NOTICE/third-party 文件存在、固定版本在
Dockerfile/agent/workflow 中一致、只有 publish-container 发布 GHCR 且保留 SBOM；传入
`--image socks-gateway:mvp` 时还检查镜像内许可文件可读并核对 `mihomo -v`。

```powershell
docker buildx build --load --platform linux/amd64 -f apps/server/Dockerfile -t socks-gateway:mvp .
node deploy/verify-distribution.mjs --image socks-gateway:mvp
```

**提交：** `docs: document the gateway-only distribution`

### Task 18：完整本地验收

**自动化命令：**

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @metacubexd/ui exec playwright install chromium
pnpm --filter @metacubexd/ui test:e2e
node deploy/verify-contract.mjs
docker compose -f deploy/compose.yaml -f deploy/compose.build.yaml config --quiet
docker buildx build --load --platform linux/amd64 -f apps/server/Dockerfile -t socks-gateway:mvp .
node deploy/verify-distribution.mjs --image socks-gateway:mvp
```

Linux CI 或新主机先运行
`pnpm --filter @metacubexd/ui exec playwright install --with-deps chromium`。Linux + Docker 可用时
随后运行 `bash deploy/smoke.sh --image socks-gateway:mvp`；Windows 无 Linux 容器环境时该项明确
记为 `not-run`。

**静态安全检查：**

- 生成配置快照无 `DIRECT`、`udp: true`、匿名 listener、mixed/HTTP/TUN；
- API/日志/测试快照无密码、订阅 URL、Controller secret、master key；
- 最终 workspace 只包含 `apps/server`、`packages/agent` 和 `packages/ui` 三个运行包；
- 根 MIT、NOTICE、Mihomo license/source 和镜像内许可文件均通过 distribution 检查，镜像运行时
  Mihomo 版本与固定 tag 一致；
- 只有 `publish-container.yml` 发布 GHCR，且发布 workflow 保留 SBOM；
- `git status --short` 只显示明确的验收修复，验收结束时保持干净。

**Docker/Linux smoke（环境可用时）：**

- 容器 healthy；
- 8080/9090 只监听 loopback；
- 启用后 10001–10010 只监听 TCP；
- 错误账号、未绑定账号和匿名连接均失败；
- 容器重启后状态保持；
- 配置故障恢复上一版；
- 所有候选故障时没有直连出口。

缺少 Docker、Linux 或真实节点时，相应项目标记 `not-run`，不得以单元测试代替。最后对 Task
16–18 增量运行 `ponytail-review`，随后做一次仅覆盖未审查增量的最终精简审查。

**提交：** 只有验收发现并修复问题时才创建 `fix: close MVP acceptance gaps`。

## 8. 交付检查点

1. **后端闭环：** Task 9 完成；10 端口、链路、账号、节点、API 在本地测试通过。
2. **快速可用 MVP：** Task 13 完成；管理员可以仅通过 Web 完成日常操作。
3. **精简版本：** Task 15 完成；桌面和通用 MetaCubeXD 产品面被移除。
4. **稳定本地版本：** Task 18 完成；本地、CI 和可用 Docker 门禁均有明确结果。

预计 Task 13 在 7–10 个有效开发日内形成可操作版本；Task 18 在 12–18 个有效开发日内形成
稳定版本。估算不包含等待真实 VPS、节点或部署授权的时间。
