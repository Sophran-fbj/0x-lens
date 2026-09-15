# 0x Lens

[English](README.md) | 简体中文

[![CI](https://github.com/Sophran-fbj/0x-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/Sophran-fbj/0x-lens/actions/workflows/ci.yml)

> 在网页上悬停任意 Ethereum 地址或 ENS 名称，即刻查看其链上身份。

Chrome 扩展 · Manifest V3 · Ethereum 主网。

## 第一眼摘要

| | |
|---|---|
| **问题** | Ethereum 身份散落在各种网页中，逐个确认往往需要离开当前页面并打开区块浏览器。 |
| **我做了什么** | 一个 Chrome 扩展，把地址和 ENS 名称变成可悬停的身份卡片，并提供持久侧边栏。 |
| **技术栈** | React · TypeScript · WXT · viem · Chrome MV3 · Framer Motion |
| **演示 / 安装** | 下方提供演示；可以运行 `npm run build` 本地构建，或从带版本标签的 GitHub Release 下载 ZIP。 |

**52 项浏览器 E2E + 10 项 RPC 检查 · 不修改宿主页面 DOM · 无遥测 · 单一 RPC 网络出口**

最值得看的三个技术点：

- 使用 `Range.getClientRects()` overlay 标注文本，不修改宿主页面 DOM。
- 所有链上访问都留在 MV3 service worker；禁用 CCIP-Read，并阻止非 RPC 网络请求。
- 分片且感知 DOM 变化的扫描器能够处理 SPA 更新、节点移动、布局变化和 ENS / 地址边界情况。

![悬停卡片演示](docs/hover.gif)

当地址出现在文章、事故复盘或代码讨论中时，只需悬停：地址亮起，扫描线划过——扫描动画
本身就是加载状态——随后身份卡片展开，显示 ENS、ETH 余额、EOA / 合约 / Token 类型，
以及 Pectra 之后的 EIP-7702 委托信息。点击即可在侧边栏中查看完整结果。

它同时支持链上身份的两个方向：十六进制地址（包括从链接 `href` 恢复的
`0x1234…abcd` 截断形式），以及正文中的 ENS 名称（例如将 `vitalik.eth` 正向解析为账户）。

![侧边栏演示](docs/panel.gif)

## 设计原则

- **不连接钱包，不注册，不登录。** 安装后直接浏览。
- **无第三方 API、无后端、无遥测。** 唯一数据源是 Ethereum JSON-RPC；除发送到所配置
  RPC 端点的链上身份查询外，没有其他数据离开浏览器。CCIP-Read 被禁用，service worker
  的 `fetch` 也会拒绝非 RPC 来源。页面正文不会被上传，进入页面可见 UI 的错误信息只有
  稳定错误码，不包含可能泄露 RPC 地址或密钥的原始错误。
- **不修改宿主页面。** 高亮通过 `Range.getClientRects()` 计算，并绘制在隔离的 Shadow DOM
  overlay 中，不会干扰 React、Vue 或其他框架的 DOM reconciliation。
- **它是透镜，不是区块浏览器。** 需要深入查看时，可以一键跳转 Etherscan。

## 可读取的信息

| 项目 | 内容 |
|---|---|
| ENS | 地址反向解析与 `.eth` 名称正向解析（通过 universal resolver 的纯 RPC 请求） |
| 余额 | `eth_getBalance`，全程避免浮点数计算 |
| 账户类型 | 无 bytecode → **EOA**；`0xef0100‖addr` → **带 EIP-7702 委托的 EOA**；其他情况 → **CONTRACT** |
| Token 元数据 | 对合约调用一次 Multicall3，探测 `name`、`symbol`、`decimals`；显示为 `TOKEN · USDC`，不宣称经过 ERC-20 认证 |
| 空状态 | 零余额、无 ENS、无合约代码 → *NO ON-CHAIN FOOTPRINT* |

检测使用 `/\b0x[a-fA-F0-9]{40}\b/g`，混合大小写地址必须通过 EIP-55 校验，全小写和全大写
地址也会接受。截断地址 `0x1234…abcd` 只会从最近的链接 `href` 中恢复，恢复结果必须通过
checksum，并与可见的前后缀一致。ENS 支持 ASCII 标签和 `.eth` 后缀，同时排除邮箱域名；
未注册名称会显示专用空状态。

已知且诚实处理的缺失场景：链接外的截断地址；`name()` 返回 `bytes32` 的旧 Token
（例如 MKR，会显示为普通合约）；以及依赖 offchain CCIP-Read resolver 的名称——为了保持
单一网络出口和隐私保证，此能力被主动禁用。

## 实测数据

初始扫描通过 `requestIdleCallback` 分片执行，不阻塞关键渲染路径。以下 wall time 包含页面
加载期间的 idle 调度等待，每个主线程扫描分片最多运行 8 ms：

| 页面 | 文本节点 | 高亮数量 | 扫描 wall time |
|---|---:|---:|---:|
| 测试页面（含压力区共 175 个身份） | ~220 | 175 | 稳定约 600 ms |
| etherscan.io Token 页面 | ~2100 | 1 个通过 `href` 恢复的截断地址 | 通常 20–90 ms，繁忙加载时约 1 s |
| Wikipedia · Ethereum | 1977 | 0 | 20–170 ms |

首次悬停到数据显示约需 1.7–2.3 秒，其中包含 550 ms 获取动画和一次公共 RPC 往返；已经
扫描过的地址会从缓存读取并跳过动画，再次悬停约需 **0.22–0.27 秒**。

## 架构

```text
Content Script（顶层 frame）          Background SW                 Side Panel
  TreeWalker + regex scanner    ───▶  viem publicClient       ◀──  React 页面
  + EIP-55 校验                         batch:true                   storage.watch
  Range rects → Shadow DOM              storage.session cache       session:lens:focus
  Hover Card + Framer Motion            balance TTL 60s
```

几个经过端到端测试验证的工程细节：

- **零侵入标注**：页面绝对坐标让滚动无需额外监听；MutationObserver、WeakSet 去重和每页
  500 个匹配上限可以应对 SPA 更新和区块浏览器表格。
- **两阶段数据管线**：先并发请求 balance、bytecode 和 ENS；如果是合约，再通过 multicall
  获取 Token 元数据。卡片的两阶段展示与真实请求过程一一对应。
- **适应 MV3 service worker 生命周期**：状态保存在 `chrome.storage.session`，消息处理保持
  幂等，并发查询会合并为同一个 in-flight Promise。
- **侧边栏手势链路**：`sidePanel.open()` 是消息分支中的第一个动作，中间没有 `await`，
  避免丢失浏览器的用户手势窗口。

## 权限

扩展只申请 `storage`、`sidePanel`，以及一个 RPC 端点的 host permission。该来源由
`VITE_RPC_URL` 或 viem 默认端点推导。content script 依靠 `matches` 注入，不申请 `tabs`、
`scripting`，也不包含远程代码。

## 开发

需要 Node.js 20+ 和 Chromium 系浏览器；端到端测试默认使用系统中的 Microsoft Edge。

```sh
npm install
npm run fixture        # 启动本地测试页面
npm run dev            # WXT 开发模式
npm run build          # 生产构建输出到 .output/chrome-mv3
```

测试需要先启动 fixture 并完成一次最新构建：

```sh
node e2e/verify.mjs    # 检测层：31/31
node e2e/rpc.mjs       # Ethereum 主网数据管线：10/10
node e2e/card.mjs      # 悬停卡片完整消息链路：11/11
node e2e/panel.mjs     # 侧边栏及用户手势链路：10/10
node e2e/perf.mjs      # 真实网站扫描性能
node e2e/demo.mjs && node e2e/convert.mjs   # 重新生成演示 GIF
```

### CI 与 RPC 测试边界

GitHub Actions 会在每次 push 和 pull request 时自动运行：

- `npm run compile`
- `npm run build`
- 针对本地 fixture 的 `node e2e/verify.mjs`：共 31 项离线浏览器检查，不访问 Ethereum RPC。

以下测试会主动访问 Ethereum 主网：

- `node e2e/rpc.mjs`：10 项 RPC 数据管线检查。
- `node e2e/card.mjs`：11 项浏览器检查，覆盖 content script → service worker → RPC 的真实链路。
- `node e2e/panel.mjs`：10 项浏览器检查，包含 RPC 和侧边栏用户手势链路。

`VITE_RPC_URL` 是可选环境变量；未配置时使用 viem 的公共主网端点。为了提高本地或私有 CI
的稳定性，可以设置自己的 RPC 地址。不要提交该值，`.env` 已被忽略。

提示：持久化浏览器 profile 可能缓存旧 service worker。如果 background 修改后行为没有变化，
请删除 `.playwright-profile` 后重新运行测试。

## 发布

推送版本标签后，GitHub Actions 会先运行离线 CI，再通过 WXT 打包扩展，并把 Chrome ZIP
发布到 GitHub Releases。创建标签前，需要先更新 `wxt.config.ts` 中的 `manifest.version`：

```sh
git tag v0.1.0
git push origin v0.1.0
```

Chrome Web Store 发布仍需手动完成，因为它需要开发者账号和商店审核。

## 路线图（暂不进入 V1）

多链（Base / Arbitrum）· 仅在视口范围内预取 · USD 价格 · 按网站启停 · 高亮键盘操作 ·
Unicode / Emoji ENS（ENSIP-15 normalization）。

## 许可证

MIT
