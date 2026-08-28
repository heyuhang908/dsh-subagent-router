# @dsh-external/dsh-subagent-routing-console

子代理路由台：为所有委派通道（subagent/fork/workflow worker/ralph 等一切经本进程
LLM 运行时的子会话）提供「模型 + 思考强度」的路由覆盖。

- **始终托管**：路由台接管所有委派子请求（`enabled` 恒为 true，不可关闭）；
  未配置任何覆盖时**跟随父级**（不强制改写，v0.0.2 起）；路由故障时放行父级路由（fail-open）
- **五层优先级链**（从低到高，逐层按字段继承；provider/model 需完整对才能替换身份）：
  1. **全局默认**（`defaultOverride`）——最低优先级的兜底路由
  2. **关键词自动规则**（`autoRules`）——任务文本（子代理首条消息或父会话最近用户消息）
     命中关键词时应用对应角色预设；宿主强制匹配，模型无感（v0.0.6 起）
  3. **通道规则**（`rules`，`'*'` 为兜底）
  4. **会话角色绑定**（`sessionRoles`）——引用式绑定（会话 → 预设键），命中即**整组替换**
     为该角色绑定路由；与全局默认彻底独立，缺失字段回落父级而非全局默认（v0.0.7 起）
  5. **会话自由覆盖**（`sessionOverrides`）——面板/工具写入的显式值，最高优先级
- **全局默认**：会话开始前在侧栏设置，影响所有未来委派；与角色预设相互独立
- **会话级覆盖**：`sessionOverrides`（key = 发起委派的顶层会话 id）仅对该会话派生
  的子代理生效；会话内可经面板/`subagent_route` 单独修改
- **角色预设**：🔍侦察/🧐评审/🏗️架构（模型+强度组合档案，面板「角色预设」Tab 可视化绑定）
  + 强度预设 chips；`subagent_route action=preset` 按会话绑定（引用式，实时生效）
- **实时性**：`agent/request` 每请求实时解析当前策略——工具/面板改动即时生效；
  policy.json 文件监听（300ms 防抖）让**手改也实时生效**，无需重启或 reload
- 侧栏常驻面板五个 Tab：本会话 / 全局默认（强度预设 chips）/ **角色预设**（绑定编辑器
  + 本会话角色下拉）/ 通道规则 / 活动监控（含改写来源标注：自动规则命中/会话角色绑定）
- 会话覆盖（含当前会话）统一在侧栏面板「本会话」Tab 管理；旧版输入栏固定悬浮窗已移除，
  client 仅保留一个空渲染 tracker（conversation.input.dock slot）向面板广播当前会话 ID
- host 数据面：`/subagent-routing-console/state`（GET）/ `/subagent-routing-console/policy`（PUT）
- 对话内工具：`subagent_route`（show / set / preset / inherit，scope=session 默认）+
  `subagent_wait`（等待后台子代理结算并回收结果，超时保护，v0.0.4 起）
- 生效机制：`dsh-agent` 的 `agent/request` 瀑布替换（子代理 step 构建时改
  provider/model/reasoningEffort，request/header 留痕），think 强度经 `resolveModelInfo`
  校验，不被目标模型支持时按设计忽略并记录（不阻断委派）。子代理归属解析：
  沿 session header 的 `parentSession`/`origin` 上溯到 `origin !== subagent` 的顶层会话。

## 安装

方式一：GitHub Release 下载 tgz（免构建）

```bash
# 从 Releases 下载 dsh-external-dsh-subagent-routing-console-<version>.tgz 并解压到任意目录
tar -xzf dsh-external-dsh-subagent-routing-console-0.0.1.tgz
# 注入器环境：运行时注入（免重启）
dev_inject_plugin <解压出的包目录>
```

方式二：clone 构建

```bash
git clone https://github.com/heyuhang908/dsh-subagent-routing-console.git
cd dsh-subagent-routing-console
npm install
bash scripts/build.sh
# 注入器环境：dev_inject_plugin <本目录>；正式装配：dev_install_package <本目录>（重启后由 profile bundles 接管）
```

## 构建

```bash
# 需 DSH_CHECKOUT 指向含 packages/ 的 dsh 源码 checkout（build.sh 自动探测常见路径）
bash scripts/build.sh   # tsc 编译 host → tsdown 打包 client
```

## 装配（正式插件路径）

```bash
# 注入器环境内：dev_install_package <本目录>（profile=web）
# 效果：profile package.json dependencies += link + dsh.profile.bundles += 包名
#       重启后由 bundles 列表自然装配（无需注入器看守）
```

## 客户端挂载方式

侧栏常驻面板：**直接 DOM 挂载**到侧栏列（`[data-pane="sidebar"]` 等选择器 +
MutationObserver 自愈，参照 activity-heatmap 已验证模式）。**不用 conversation.view
slot**：它是 session-scope 且空白会话（新会话未发消息）时整个对话视图区不渲染，
导致「会话开始前不可见」——侧栏挂载才能会话前配置全局默认。

## 踩坑记录

- `agent/request` 监听的 disposer 必须收集并在 effect cleanup 调用：热重载时旧
  fiber 的 ctx.on 监听器残留会带着**旧 policy 闭包**截获请求，表现为新策略不生效
  （本插件首次上线踩过，症状：rewrites 恒 0 + note 显示旧策略状态）。
- client 骨架扫描器要求 `inject` 含 `slots` + `slots.register({name:'<已知slot>'})`
  紧邻形态；本插件以 sidebar.footer.action 空条目作为扫描器锚点（真实面板走 DOM）。
