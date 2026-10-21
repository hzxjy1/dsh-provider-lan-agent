# @local/dsh-provider-lan-agent

把局域网内的 agent 服务（`https://10.219.9.56`）接成 DSH 的一个原生 LLM provider 路由 `lanagent`。

架构与厂商请求 seam 见 [ARCHITECTURE.md](./ARCHITECTURE.md)；离线契约测试见 [test/contract/](./test/contract/)。

## 为什么不是普通适配器

`POST /chatbot/v3/task-agent` 是**服务端 agent 协议**，不是模型协议（实测）：

- 请求 `messages` 只有 `user` / `assistant` 两种角色，没有 system / developer / tool。
- 客户端无法下发工具 schema；服务端 agent 在生成过程中**反向**经 WebSocket
  `wss://<host>/ws-api/coagent/<session_id>` 把工具调用推给客户端执行。**没有 30 秒硬超时**：
  实测迟到 45s / 130s 的应答仍被采纳（等待期间每秒一条心跳），而 400s 时服务端会在 **~333s 自行超时收尾**；
  即真正的预算是**厂商为每个工具声明的 `timeout`**（`execute_command` 实测 300000ms = 5 分钟）——见 ARCHITECTURE.md。
- `action` 必须是 CLI 用的 `"自由提问"`。桌面端的 `action.chat` + `client/server` 角色会让服务端
  **看不到用户消息**，只回通用问候语（本项目早期踩过的坑）。

所以本插件自己拥有**一轮的两个通道**：

```
HTTP  POST /chatbot/v3/task-agent   → 答案流（累积快照，需按块 id 差分）
WS    /ws-api/coagent/<session_id>  → 服务端的工具调用，在本进程内执行并应答
```

## 状态

| 能力 | 状态 |
|---|---|
| 认证：账号密码登录 → JWT（内存缓存、`-103/-106` 自动重登、失败指数退避 + 每小时上限） | ✅ M1 |
| 模型目录：拉 `model_groups` + 缓存 + 静态回退；`listModels` / `resolveModel` / 模型发现 | ✅ M1 |
| 请求投影：DSH 历史 → 两角色对话；系统提示词走 `rules`；skill 元数据走 `skills` | ✅ M1 |
| 流解析：拼接 JSON 解析 + 累积快照差分 → DSH `StreamChunk`；`task_status` 收尾；usage 映射 | ✅ M1 |
| 工具通道：每轮开 WS、心跳、按 `block_id` 关联、软超时 | ✅ M1 |
| **工具桥：厂商 8 个内置工具 → DSH 工具，经 `ctx.tools.execute()`（审批/沙箱归 DSH）** | ✅ M2 |
| 厂商请求 seam：`interpret` → plan / local / refusal，`render` 统一整形（bridge + loop 均已接入） | ✅ M4 |
| `use_mcp_tool` → DSH `mcp__<server>__<tool>` 的翻译 | ✅ M2 |
| MCP 工具**清单注入**（让厂商模型知道自己有哪些 MCP 工具可调） | ✅ M3 |
| 旁路轻量通道（session-title / compaction） | ✅ M1 |

**验收证据**：`node --test` **216 项全绿**（协议/认证/目录/工具翻译/派发/审计 + 19 个真实 fixture 的契约测试）；
真实服务验证脚本保留在本地，不随仓库发布；
GUI 模型选择器出现 `LAN Agent` 与 6 个模型；**真实 GUI 会话端到端跑通**
（厂商 agent 调 `execute_command` → 桥 → DSH 真跑 `pwd && ls api-reference.md && date +%s` → 输出正确，
会话日志留有 `tool/ptc-dispatch-start` 证据）。

## 配置

`cordis.patch.yml` 里的 `llm-lan-agent` 行；字段含义见 `index.js` 的 `Config` 与 ARCHITECTURE.md。要点：

- `auth.mode: login`（默认）：用 `auth.passwordRef` 指向的凭据换 JWT。
- `auth.mode: token`（逃生开关）：直接读已有 JWT，完全不登录。
- `toolBridge: dsh`（默认）把厂商的工具调用送进 `ctx.tools.execute()`；
  改成 `refuse` 则一律回错误（隔离"协议问题"与"工具执行问题"时有用）。
- `mcpToolbox: enabled`（默认）把白名单里的 DSH 工具合成一个 MCP 服务器（`dsh_toolbox`）声明给厂商，
  于是它可以用 `use_mcp_tool` 调到串口、远程 claw、子代理、规划这些它自己没有的能力。
  **注意成本**：白名单里的每个 schema 都要随每次请求发送——实测 `mcp__*` 全量是 64 个 schema ≈ 11.8K tokens，
  默认收窄到 17 个 ≈ 2.6K tokens（`mcpToolWhitelist` 可调，支持 `prefix*`；`mcpToolboxMaxTools` 是上限）。
- `toolDispatch: auto`（默认）自动选择派发路径：先直派，若该会话是 DSH 的 **PTC 呈现模式**
  （模型只被允许直接调 `run_code`）则改把调用包成 `run_code` 程序（DSH 文档化的路径）。
  可固定成 `direct` 或 `run_code` 排障。

## 账号与密码怎么填

**两者都当隐藏信息**，都走 DSH 凭据 seam（`~/.dsh/.credentials.yaml` 的 `refs:`，权限 600，
或进程环境变量 / `.env`）。配置文件里**只有引用名，没有明文，也没有账号**：

```yaml
# ① 直接写凭据存储
refs:
  LAN_AGENT_USER: user            # 账号（厂商 API 里叫 user）
  LAN_AGENT_PASSWORD: <你的密码>
```
```bash
# ② 环境变量（seam 的第一层就是环境变量）
export LAN_AGENT_USER='user'
export LAN_AGENT_PASSWORD='<你的密码>'
```
③ 设置界面的 Models 页：本行的 `userRef` / `passwordRef` 在 schema 里都带
`role: "credential-ref"`，所以它们可以像 API key 一样被写入。

优先级：**凭据 ref 优先**，Config 的 `user` 字段只是回退（两者都在且不一致时会告警，
不会静默登错账号）。

自检（只打印是否存在与长度，不回显）：

```sh
python3 - <<'EOF'
import re
from pathlib import Path
t = (Path.home() / '.dsh' / '.credentials.yaml').read_text(encoding='utf8')
for key in ('LAN_AGENT_USER', 'LAN_AGENT_PASSWORD'):
    m = re.search(rf'(?m)^  {key}:\s*(\S.*)$', t)
    print(f'{key}: 已配置，长度 {len(m.group(1).strip())}' if m else f'{key}: 未配置')
EOF
```

> `resolve` 是**每次操作重读**的，填完后下一次请求即生效，无需重启。
> 登录失败会指数退避（默认 30s → 30min，每小时上限 6 次）——厂商的密码错误码没人测过，
> 据说是怕 SSO 锁定，所以这里刻意不让失败变成重试风暴。

## 工具桥做了什么（M2）

厂商的 8 个内置工具被翻译成 DSH 工具，并且**回传文本严格贴合厂商模型见过的形状**
（`list_files` 回路径 JSON 数组、`write/replace_in_file` 回字面量 `"success"`、
`read_files` 回 `{path: content}`、`execute_command` 回 `{success,output,error}`）：

| 厂商工具 | DSH 工具 | 说明 |
|---|---|---|
| `get_environment_info` | 本地实现 | 每轮都调用；由 seam 返回本地答案，只读 git 元数据，不走审批 |
| `execute_command` | `bash` | 补必需的 `description`；`.` 工作目录交给 DSH 的会话 cwd |
| `read_files` | `read` | 优先用结构化 `value.lines` 还原裸内容；loop 只有文本时解析行号渲染 |
| `list_files` | `glob` | `recursive` → `**/*`；绝对路径转工作区相对 |
| `search_files` | `grep` / `glob` | 按 `claude_name` 分派（Grep/Glob/legacy） |
| `write_to_file` | `write` | |
| `replace_in_file` | `edit` | plan 阶段按厂商的空白容错解析 diff，只发精确 `edit`；不再执行后 read→patch→write |
| `use_mcp_tool` | `mcp__<server>__<tool>` | |

翻译与整形现在由 `src/vendor/registry.js` 的单一 seam 负责：`interpret` 产出 plan / 本地答案 / 拒绝，
`render` 统一整形；`src/vendor/bridge.js` 只是带外 runner，`src/tools.js` 保留格式化与本地预检读取。

### 工具由谁执行（`toolExecution`）

| 配置 | 默认 | 含义 |
|---|---|---|
| `toolExecution` | `loop` | `loop` = 交给 DSH 的 agent loop 执行：对话里出现**原生"运行命令"卡片**、审批走 loop、轨迹与 `tool/call` 记录完整；`out-of-band` = 桥自己执行并立即应答（对话里看不到，改看审计面板） |
| `loopCallStyle` | `auto` | `loop` 模式下交给 loop 的名字：`native` 交真实工具名（如 `bash`）；`run_code` 交生成的程序；`auto` 按会话学习——PTC 预设只允许 `run_code`，首次被拒后自动改用程序，那一轮厂商不会失败 |
| `loopBudgetMs` | `240000` | 厂商未为该工具声明 `timeout` 时的兜底预算；声明了就用声明的（`execute_command` 是 300000ms） |

> **工具失败的如实回报**：拒绝（PTC 拒绝直接名）或 `Error: …` 一律作为错误回给厂商，绝不会把失败的
> 写/编辑报成 `success`；同一调用最多换一次风格，两次都被拒就如实回报，不会反复重试。
>
> 想看字面的"运行命令"卡片，会话需跑在 native / `mode: code` 预设下；PTC 预设下卡片写的是 `run_code`（内层
> `bash` 在轨迹里可见）。首次调用若被呈现层拒绝，会自动改用程序重试，代价是那一张卡片显示为失败。

## 安装

包以本地路径安装（profile 的 `node_modules/@local` 符号链接），不从公共 registry 发布：

```sh
pnpm test          # 216 项离线测试
```

## 测试

```sh
node --test                        # 216 项离线测试：解析/差分/投影/rules/认证/目录 + 工具翻译 + 契约 fixture（无需锚点）
node --test test/contract/*.test.mjs  # 只跑契约测试：19 个 case，value 与 text-only 两种 outcome
```

## 排障

- 报 `MISSING_CREDENTIAL` 时，看错误末尾的括注：`credentials service is not reachable from this plugin`
  是"插件拿不到凭据服务"，`reachable, but that reference resolves to nothing` 是"服务能拿到但该 ref 没值"。
  两者处置完全不同（前者是代码/装配问题，后者是去填凭据）。
- **改动本插件代码后必须重新启用插件（或重启 dsh）**：插件模块只在 fiber 建立时导入一次，
  改文件不会热加载；`Config.listConfigs` 里出现你刚加的字段，才说明新代码真的生效了。

## 已知限制

- 工具调用默认不进 DSH 的模型可见记录（`ctx.tools.execute()` 不写 `tool/call`，那是 agent loop 的职责）；
  但在 **PTC 会话**里，调用会作为 `run_code` 子派发写进会话日志（`tool/ptc-dispatch-start`）。
- 厂商的 SEARCH/REPLACE 匹配是**模糊**的（精确 → 逐行 trim → 首次出现）；DSH 的 `edit` 只做字面匹配。
  桥接了常见近似（SEARCH 块多余的行尾换行会重试一次），其余情况把厂商自己的
  "请让 SEARCH 与文件完全一致"提示回给模型。
- 每轮固定约 **15.8K token** 的厂商系统提示词成本，与本轮内容多少无关。
- 纯文本：请求体没有图片字段，v1 按 `inputModalities: ['text']` 宣告。
- 上下文 204800、输出上限 16384（厂商 25 条模型定义的实测值）。
- 目标私有且会变：`action` 字面量、`config.agent_behavior_mode`、8 个工具名都是逆向所得。

## 打包注意（踩过的坑）

本地 link 安装的包**不会解析 peerDependencies**（pnpm 会明确警告）。因此本插件
**不裸导入任何 `@deepseek-ai/*`**：适配器是结构化实现（不 `extends LlmAdapter`），
schemastery 通过「先试裸导入 → 再从 `process.argv[1]` 向上找 dsh 安装目录」的懒加载获取，
失败就不导出 `Config`（插件仍能加载，只是设置界面看不到配置项）。
装好后用 `Config.listConfigs` 查本行，`status` 应为 `schema`。

另外：包已在 profile manifest 里时，`install_bundle` 会因为 `pnpm add` 成为 no-op 而报
`ambiguous-install`；正确顺序是 `remove_bundle` → `install_bundle <绝对目录>`。
