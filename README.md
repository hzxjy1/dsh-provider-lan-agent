# @local/dsh-provider-lan-agent

把局域网内的 agent 服务（`http://10.219.9.56`）接成 DSH 的一个原生 LLM provider 路由 `lanagent`。

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
| 流解析：拼接 JSON 解析 + 累积快照差分 → DSH `StreamChunk`；`task_status` 收尾；厂商 usage 仅旁路观测、完成时上报本地 tokenMeter 压力 | ✅ M1 |
| 工具通道：每轮开 WS、心跳、按 `block_id` 关联、软超时 | ✅ M1 |
| **工具桥：厂商 8 个内置工具 → DSH 工具，经 `ctx.tools.execute()`（审批/沙箱归 DSH）** | ✅ M2 |
| 厂商请求 seam：`interpret` → plan / local / refusal，`render` 统一整形（bridge + loop 均已接入） | ✅ M4 |
| 思维链：厂商 `thinking` 块 → DSH `reasoning` 块（GUI 可折叠显示，`thinkMode` 控制是否请求） | ✅ M4 |
| `use_mcp_tool` → DSH `mcp__<server>__<tool>` 的翻译 | ✅ M2 |
| MCP 工具**清单注入**（让厂商模型知道自己有哪些 MCP 工具可调） | ✅ M3 |
| 旁路轻量通道（session-title / compaction） | ✅ M1 |
| 厂商交互提问：`ask_followup_question` → DSH `ask_user_question`（真实工具调用，用户答案在同一轮回到模型，模型继续干活） | ✅ 1.4.0 |
| **"假完成"不再伪装**：厂商宣布完成却没有正文 / 工具调用后没有最终答复 / 断流没有终态 → protocol error，不再显示成"正常结束" | ✅ 1.4.0 |
| 可观测性：`toolAuditFile` 在出厂配置里启用（绝对路径 JSONL，含每次工具请求 + 每轮收尾记录） | ✅ 1.4.0 |

**验收证据**：`node --test` **246 项全绿**（协议/认证/目录/工具翻译/派发/审计 + 20 个契约 fixture 的契约测试）；
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
- `mcpToolbox: enabled`（默认）把 DSH 的工具合成 MCP 声明发给厂商，于是它可以用 `use_mcp_tool`
  调到串口、远程 claw、子代理、规划、桌面自动化这些它自己没有的能力。
  **MCP 工具自动获取**：`mcpToolboxMcpAuto: true`（默认）每回合从 DSH 工具注册表发现所有已加载的
  MCP 服务器，并按**真实服务器名**分别声明（`mcp__<server>__<tool>` → 服务器 `<server>` + 裸工具名）——
  新增 MCP 服务器只要装进 DSH 就会自动出现在厂商的工具箱里，不必再手改 `mcpToolWhitelist`。
  `mcpToolWhitelist` 因此只负责**非 MCP** 的工具名（`ask_user_question`、`skill`、`web_*`、`subagent`…）；
  显式写 `mcp__…` 仍然有效，与自动发现去重，可作为自动模式失效时的基线。
  **注意成本**：每个 schema 都要随每次请求发送——实测 `mcp__*` 全量是 64 个 schema ≈ 11.8K tokens，
  当前组合 48 个；`mcpToolboxMcpDeny` 按前缀裁掉不值得的服务器，`mcpToolboxMaxTools`（当前 100）是硬上限——
  留余量是必须的，因为超出时从白名单**尾部**丢弃（自动发现的排在最后，先被裁，显式条目受保护），
  48 时刚好顶满，再加一个工具就会静默丢一整个服务器。
  **厂商原生 skill 的机制**：请求里带一个 `skills` 通道（`{name,description,filePath,whenToUse}`，
  `filePath` 是本机绝对路径）。模型调它自带的 `Skill` 时，**服务端**按名字查这条通道拿到路径，再向客户端
  发一个 `read_files(path)`——读取由我们执行，正文回到模型。所以通道为空时它只会回 `skill path is None`
  （实测：`ctx.skills.list()` 不传 scope 时恒为空，与 DSH 会话里明明有 13 个技能无关；已修）。
  工具箱里的 `skill` 仍是更好的入口：它额外返回 `resourceBase`，技能正文里的相对路径靠它解析。
- `toolDispatch: auto`（默认）自动选择派发路径：先直派，若该会话是 DSH 的 **PTC 呈现模式**
  （模型只被允许直接调 `run_code`）则改把调用包成 `run_code` 程序（DSH 文档化的路径）。
  可固定成 `direct` 或 `run_code` 排障。
- 交互提问的等待预算很长：映射后的 `ask_user_question` 是一个**停在 loop 里的调用**，
  最多等 **9 分钟**（内部 `ASK_USER_BUDGET_MS` = 540,000 ms）。用户走开再回来，答案仍作为
  工具结果回到同一轮、模型继续，不会变成"工具超时"。为什么不是更久：PTC 预设下这次提问跑在
  生成的 `run_code` 程序里，而 DSH 给一个程序的墙钟上限是 **600s（含嵌套等待）**，9 分钟留出
  一分钟余量，让我们先给出干净的"提问超时"，而不是被 DSH 在程序层杀掉。
- `run_code` 信封带上真实预算：PTC 会话里 loop 路由的调用会被包成一个 `run_code` 程序，而 DSH
  给程序的**默认墙钟只有 120s**（上限 600s，且**包含**嵌套工具与审批等待）。旧版不传
  `timeoutMs`，于是任何超过两分钟的正常调用都会被 DSH 以
  `code run failed (timeout): execution deadline reached (120000ms)` 杀掉——实测那条 255s 级的
  远程命令就是这样死的。现在信封会带上该调用自己的 parked 预算（普通调用 = `loopBudgetMs`，
  交互提问 = 540s），并钳在 DSH 的 600s 上限内。

## 账号与密码怎么填

**升级提示**：本版本的凭据引用名是 `LAN_AGENT_USER` / `LAN_AGENT_PASSWORD`。如果从旧版本升级，请把账号和密码复制到这两个引用下（Models 页可直接写入），旧引用名不再读取。

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

厂商的 8 个内置工具被翻译成 DSH 工具（交互提问 `ask_followup_question` 也映射成真实工具调用），并且**回传文本严格贴合厂商模型见过的形状**
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
| `ask_followup_question` | `ask_user_question` | 厂商原生交互提问 → DSH 真实提问工具（问题和选项都转换；答案作为工具结果回到厂商模型） |

翻译与整形现在由 `src/vendor/registry.js` 的单一 seam 负责：`interpret` 产出 plan / 本地答案 / 拒绝，
`render` 统一整形；`src/vendor/bridge.js` 只是带外 runner，`src/tools.js` 保留格式化与本地预检读取。

### 工具由谁执行（`toolExecution`）

| 配置 | 默认 | 含义 |
|---|---|---|
| `toolExecution` | `loop` | `loop` = 交给 DSH 的 agent loop 执行：对话里出现**原生"运行命令"卡片**、审批走 loop、轨迹与 `tool/call` 记录完整；`out-of-band` = 桥自己执行并立即应答（对话里看不到，改看审计面板） |
| `loopCallStyle` | `auto` | `loop` 模式下交给 loop 的名字：`native` 交真实工具名（如 `bash`）；`run_code` 交生成的程序；`auto` 按会话学习——PTC 预设只允许 `run_code`，首次被拒后自动改用程序，那一轮厂商不会失败 |
| `loopBudgetMs` | `360000` | `loop` 路由下 parked 调用的**上限**（厂商自己声明的 `timeout` 在此上限内被尊重），也是厂商未声明超时时的兜底。360000 高于厂商实测 ~333s 的自行收尾，所以我们的预算永远不会抢在厂商自己的 300000ms 前面 |
| `approvalTimeoutMs` | `120000` | 审批请求（policy=ask）最多等多久才告诉厂商"未获批准"。它以前借用 20s 的每工具超时，正常的慢审批会被厂商误读成工具超时 |
| `toolTimeoutMs` | `20000` | 带外（bridge）路由上**真正在跑**的工具的软截止；审批等待已不再用它 |
| `requestTimeoutMs` | `600000` | 单轮请求的硬截止。厂商实测有 282–312s 的静默等待，300s 曾把它们截成 "the turn exceeded the 300s request timeout" |
| `toolAuditFile` | `$DSH_HOME/logs/lanagent-audit.jsonl` | 空 = 关闭；出厂配置启用，用**绝对路径**（cwd 不稳定）。JSONL 记录每次工具请求与每轮收尾，设置页诊断面板读的就是它 |

> **工具失败的如实回报**：拒绝（PTC 拒绝直接名）或 `Error: …` 一律作为错误回给厂商，绝不会把失败的
> 写/编辑报成 `success`；同一调用最多换一次风格，两次都被拒就如实回报，不会反复重试。
>
> 想看字面的"运行命令"卡片，会话需跑在 native / `mode: code` 预设下；PTC 预设下卡片写的是 `run_code`（内层
> `bash` 在轨迹里可见）。首次调用若被呈现层拒绝，会自动改用程序重试，代价是那一张卡片显示为失败。

### 为什么它会“自己停下来”

两条独立的原因，修法也不同：

**1. 交互提问被拒绝，模型只好用文本问。** 厂商 agent 源自 Cline，带一个 `ask_followup_question`
工具（参数 `{question, options?}`）。旧版 `src/vendor/registry.js` 把它列进 `INTERACTION_TOOLS`
直接拒绝（`-10001`，"current v1 does not support it; ask in text"）——于是厂商模型退化成在正文里
用文字提问，这一轮就结束了，看起来就是“它自己停了”。
现在它被翻译成真正的 DSH `ask_user_question` 调用
（`{questions:[{id:'vendor-followup', question, options: [{label}]}]}`，没有选项时省略 `options`），由 DSH 的
agent loop 执行：用户在 GUI 里回答，答案作为**普通工具结果**在同一轮回到厂商模型，模型继续干活。
一个 parked 的交互提问有 9 分钟的等待预算（内部 `ASK_USER_BUDGET_MS` = 540,000 ms；
PTC 预设下 DSH 给 `run_code` 程序的墙钟上限是 600s，留一分钟余量），
用户走开再回来也不会变成工具超时。其余交互类工具（`enter_plan_mode`、`plan_mode_respond`、
`switch_mode`、`todo_list_snapshot`、`restore_tool`）仍然拒绝——它们没有 DSH 对应物，而不是被静默吞掉。
rules 通道也不再教模型“用文本问”，因为 DSH 工具箱本来就发布了 `ask_user_question`。

**2. “假完成”以前被当成正常收尾。** `src/stream.js` 以前无条件把厂商的
`task_status: 'completed'` 映射成 `finish: stop`；正文流 EOF 又默认成 `stop`（除非已经见过工具调用）。
于是“厂商宣布完成、却什么也没给用户看”在 GUI 里显示成一次**正常但空**的结束。
现在 mapper 会跟踪这一轮**是否真的产生了正文**、**是否还有待决的工具调用**，并在三种情况下报
protocol error：

| 情况 | 报错 |
|---|---|
| `completed`，但整轮既没有正文也没有工具调用 | `lanagent: the vendor reported task completion without any answer text or tool call` |
| 工具调用之后立刻 `completed`，该调用后没有最终正文 | `lanagent: the vendor reported task completion after a tool call, without a final answer` |
| 正文流 EOF 而没有终态 `task_status` | 一律 protocol error（提示待决工具调用 / 无内容 / 连接被切断），不再默认 `stop` |

只有 reasoning/thinking 的轮次算“没有正文”——这是刻意的：那些内容没有展示给用户，不能拿它冒充回答。
现在用户看到的是**错误横幅**，而不是一次看起来成功的空结束；“厂商到底宣布了什么”也能在
`toolAuditFile` 的 `turn` 记录里看到（见下）。

## 安装

包以本地路径安装（profile 的 `node_modules/@local` 符号链接），不从公共 registry 发布：

```sh
pnpm test          # 246 项离线测试
```

## 测试

```sh
node --test                        # 246 项离线测试：解析/差分/投影/rules/认证/目录 + 工具翻译 + 契约 fixture + 出厂配置（无需锚点）
node --test test/contract/*.test.mjs  # 只跑契约测试：20 个 case，value 与 text-only 两种 outcome
```

## 排障

- 报 `MISSING_CREDENTIAL` 时，看错误末尾的括注：`credentials service is not reachable from this plugin`
  是"插件拿不到凭据服务"，`reachable, but that reference resolves to nothing` 是"服务能拿到但该 ref 没值"。
  两者处置完全不同（前者是代码/装配问题，后者是去填凭据）。
- **改动本插件代码后必须重新启用插件（或重启 dsh）**：插件模块只在 fiber 建立时导入一次，
  改文件不会热加载；`Config.listConfigs` 里出现你刚加的字段，才说明新代码真的生效了。

### 日志落在哪里

厂商工具请求原先只活在 host 的 stdout 里，而本部署的 stdout 是 **tty**——所以上一次排查什么都
没能落盘。现在出厂配置把 `toolAuditFile` 指到 `$DSH_HOME/logs/lanagent-audit.jsonl`
（`~` 与 `$DSH_HOME` 由插件展开，行里不写死任何家目录；父目录会在首次写入时自动创建；留空即关闭）：

- 每个厂商工具请求一行 JSON：`request` 在 loop 调用 park 时写、`settled` 在答案确定时写，
  两行用 `requestId` 关联；带外路由只写 `settled`。**被翻译层拒绝的请求也有记录**
  （DSH 根本没见到它，这是唯一的痕迹）。
- 每完成一个厂商轮次再写一条 `route: 'turn'` 记录：finish 种类、正文/工具调用计数、耗时——
  “假完成”因此和工具请求出现在同一个文件里。
- 文件约 **256 KiB** 封顶，超过就**原地截断**（写入一条 `truncated` 记录，不是轮转链）。
- 设置页的诊断面板读的就是同一个文件（`AUDIT_ROUTE`），面板里看到的内容就是磁盘上的内容。

插件自己的 `logger.warn('lanagent: …')` 仍然走 host 的 stdout/stderr。要让这类日志也落盘，
只能在**启动 host 时**重定向（插件代码改不了自己的 stdout）：

```sh
dsh web >> ~/.dsh/logs/host.log 2>&1
# 或者用 nohup / systemd 把 stdout、stderr 接到文件
```

最后别忘了：改了插件代码仍然要连同 host 一起重启（见上一条），否则新代码不会加载。

## 已知限制

- 工具调用默认不进 DSH 的模型可见记录（`ctx.tools.execute()` 不写 `tool/call`，那是 agent loop 的职责）；
  但在 **PTC 会话**里，调用会作为 `run_code` 子派发写进会话日志（`tool/ptc-dispatch-start`）。
- 厂商的 SEARCH/REPLACE 匹配是**模糊**的（精确 → 逐行 trim → 首次出现）；DSH 的 `edit` 只做字面匹配。
  桥接了常见近似（SEARCH 块多余的行尾换行会重试一次），其余情况把厂商自己的
  "请让 SEARCH 与文件完全一致"提示回给模型。
- 每轮固定约 **15.8K token** 的厂商系统提示词成本，与本轮内容多少无关。
- 纯文本：请求体没有图片字段，v1 按 `inputModalities: ['text']` 宣告。
- 上下文 204800、输出上限 16384（厂商 25 条模型定义的实测值）。
- 厂商的 `token_usage.used_tokens` 是厂商 agent 自己的会话计数（同一个 `chatId` 持续累积），
  不是 DSH 本次请求的 prompt；插件只把它交给 `onTokenUsage` 观测，**不再冒充 DSH `usage`**。
  一轮完成时改用 host `tokenMeter.measure()` 的本地请求压力作为 usage 样本，所以上下文占用环仍然可用；
  若 host tokenMeter 不可达，则不报 usage（环隐藏），自动压缩仍按本地 surface 估算，
  不会再被远端计数带着空转。
- 目标私有且会变：`action` 字面量、`config.agent_behavior_mode`、8 个工具名都是逆向所得。

## 打包注意（踩过的坑）

本地 link 安装的包**不会解析 peerDependencies**（pnpm 会明确警告）。因此模型路由那一半
**不裸导入任何 `@deepseek-ai/*`**：适配器是结构化实现（不 `extends LlmAdapter`），
schemastery 通过「先试裸导入 → 再从 `process.argv[1]` 向上找 dsh 安装目录」的懒加载获取，
失败就不导出 `Config`（插件仍能加载，只是设置界面看不到配置项）。

**唯一例外是 `./subagent` 入口**（1.5.0 起）：它必须裸导入
`@deepseek-ai/dsh-subagent` 与 `@deepseek-ai/dsh-subprocess`——这正是上游
CLI-wrapping subagent provider 的做法，两者已声明为 peerDependencies。profile 安装时由
dsh 自己的解析锚点解析；离线跑 `node --test` 不受影响（那套测试只导入无裸依赖的模块），
但直接跑 `scripts/subagent-harness.mjs` 需要先 `test/make-anchor.sh` 建锚点。
装好后用 `Config.listConfigs` 查本行，`status` 应为 `schema`。

另外：包已在 profile manifest 里时，`install_bundle` 会因为 `pnpm add` 成为 no-op 而报
`ambiguous-install`；正确顺序是 `remove_bundle` → `install_bundle <绝对目录>`。

## 可选的厂商 CLI 子代理能力（1.5.0）

同一个包的**第二个 host 入口** `@local/dsh-provider-lan-agent/subagent`（row id
`subagent-\u0063odechat`），加上上游 `@deepseek-ai/dsh-tool-subagent` 那一行（row id
`tool-subagent-\u0063odechat`），把厂商 CLI 接成一次性无人值守子代理，工具名
`subagent_\u0063odechat`。

**两条通道**

| 调用方 | 形态 |
|---|---|
| DSH 自己的 agent（含 PTC 会话里的 `tools.subagent_\u0063odechat`） | 异步：立刻返回 `started subagent <id>`，答案由结算通知在**下一轮**送达父会话 |
| 厂商模型（本 route 的 `use_mcp_tool(server_name="dsh_toolbox", tool_name="subagent_\u0063odechat")`） | 同上，另有 `buildRules` 里一段委派说明解释这个异步契约 |

**CLI 由运维提供，本包不下载、不给来源**

- 二进制放在 row 的 `binaryPath`（默认 `<包目录>/bin/<cli 名>`），隔离 HOME 为 `homeDir`（默认 `<包目录>/home`）。
- **文件在 → 能力在；文件不在 → 能力彻底不存在**：provider 不注册，`subagent_\u0063odechat` 工具对
  DSH agent 与厂商模型同时不可见（厂商工具箱里那条白名单自然解析不到），不会暴露一个永远失败的工具。
- 可用性由 `fs.watch`（盯目录，不是文件）+ 挂载初检 + 15s 兜底轮询维持，**装/删都不需要重启**。
- CLI 缺失时，设置页 **General 分区顶部**出现黄色横幅，写明期望路径；`GET /lanagent/cli` 提供状态。

**配置字段**（`subagent-\u0063odechat` 行）：`binaryPath`、`homeDir`、`model`（必填语义：无 `--model` 时后端永不产出）、
`mode`、`fullDelegation`/`permissionMode`、`allowedTools`、`maxBudgetUsd`、`timeoutMs`、`graceMs`、
`cwd`、`tokenFile`、`credentialsRef`。凭据优先级：`credentialsRef`（DSH 凭据库）→ `tokenFile`。

**测试**：`node --test` 覆盖 `subagent-config` / `subagent-watch`；真实委派用
`test/make-anchor.sh` + `node scripts/subagent-harness.mjs`（要活 token）。
