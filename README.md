# team-hub · 多窗口指挥台

给 [Claude Code](https://claude.com/claude-code) 用的插件（mod）。同一个项目同时开好几个 Claude 窗口时（例如一个窗口管数据、一个管页面、一个管设计），每个窗口选一个「部门」，就能：

- **互相看到在做什么**：侧边面板列出每个部门在线 / 工作中 / 空闲 / 离线，最后做了什么
- **进度与剩余时间**：工作中的部门有一条慢慢往前走的进度条，写「62% · 约剩 3 分钟」（按这一轮的步骤清单或这个部门过去的用时估算，是预估）
- **额度**：面板顶部两条小量条，显示 5 小时 / 每周额度用了多少、多久后重置
- **交接**：一个部门做完要另一个部门接着做，AI 用 `handoff` 工具写进交接队列；对方窗口弹提醒，**你按「接手」它才开始**。不用再在窗口之间复制粘贴
- **等你决定**：AI 需要你拍板时用 `ask_decision` 登记，面板最上面列出来，点一个选项，答案自动送回问的那个窗口
- **做完通知**：某个部门做完一轮超过 3 分钟的工作，其他窗口弹提示，系统也发一次通知

界面文字是中文。

## 需要什么

- Claude Code **2.1.29x 或更新**（插件用的是 function hooks，旧版本装了不会动）
- 面板在 **Claude 桌面版** 的 Code 分页里最好看（画成图）；终端里也能用（文字版）

## 安装

**只用 Claude 桌面版：** 打开 Code 分页，开一个新对话（随便选个文件夹），把下面这段贴进去，让 Claude 替你装：

```
帮我安装 Claude Code 插件 team-hub，执行这两条：
claude plugin marketplace add KS-Chong/team-hub
claude plugin install team-hub@team-hub --scope user
如果找不到 claude 指令，或者版本太旧，就用桌面版自带的 claude（Windows 在 %APPDATA%\Claude\claude-code\ 下面）。
```

它执行时会请你批准。装好后开一个新对话（或在开着的对话里打 `/reload-plugins`），插件就会加载。

**方法一（终端）：** 在系统终端（PowerShell、命令提示字元、macOS / Linux 终端）执行两行，不用打开 Claude：

```
claude plugin marketplace add KS-Chong/team-hub
claude plugin install team-hub@team-hub --scope user
```

**方法二：** 打开 Claude Code 的 CLI（终端里输入 `claude`），在对话框里输入：

```
/plugin install team-hub --marketplace KS-Chong/team-hub
```

问要不要加这个 marketplace 时按 `y`，scope 选 **user**。（桌面版的 Code 分页不支持这条指令。）

两种方法都要电脑上能执行 `claude` 指令；只装了桌面版的话，先装 [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)。装好以后，之后开的每个 Claude 窗口（包括桌面版）都会加载它；已经开着的窗口执行一次 `/reload-plugins`。

**更新：** 以后这个仓库有新版本，执行 `claude plugin marketplace update team-hub` 再 `claude plugin update team-hub@team-hub`，然后各窗口 `/reload-plugins`。

## 用法

1. 在项目的任一个窗口输入 `/hub`，面板里按 **「开启指挥台」**。没开启的项目，插件什么都不显示（只开一个窗口的项目不用开）
2. 每个窗口在输入框上方的 **「加入指挥台 [选部门 ▾]」** 选一个部门；第一次用就选「新部门…」，改好 `/hub-name 部门名称 | 一句话分工` 按回车
3. 之后：
   - 输入框上方那一行的 **「指挥台」** 按钮随时打开面板，旁边一句话写谁在做什么
   - 跟一个部门说「交接给 XX 部门」，它会用 `handoff` 写进队列
   - 协作规矩（交接用工具、多步骤先列清单、做完分层说……）由插件自动告诉每个加入了的窗口，**不用改你的 CLAUDE.md**

新开的对话，要先发第一句话（随便什么）对话才会启动，之后输入框上方才会出现「加入指挥台」。

## 数据放在哪

看板数据在 `~/.claude/team-hub/boards/<项目路径>/`，不放在你的项目里，不会被提交进项目的 git：

| 文件 | 内容 |
|---|---|
| `board.json` | 项目名、各部门和分工 |
| `status/` | 每个窗口的状态（每 30 秒心跳一次） |
| `queue/` | 交接，一条一个文件 |
| `decisions/` | 等你决定的问题 |

桌面版开在 worktree（项目的独立工作副本）里的窗口，会自动算回主项目，用同一块看板。

## 指令和工具

| | |
|---|---|
| `/hub` | 打开面板（项目还没开启就显示「开启指挥台」） |
| `/hub-name 名称 \| 分工` | 设定这个窗口的部门 |
| `handoff` / `handoff_done` | AI 用：写交接、标记交接做完 |
| `ask_decision` / `close_decision` | AI 用：登记要你决定的事、把已答的拿掉 |

## 开发

```
claude plugin validate .
claude plugin test .
```

每次改插件，把 `hooks/version.ts` 的 `VERSION` 和 `.claude-plugin/plugin.json` 的 `version` 一起加一：还在跑旧版的窗口会在输入框上方提醒「请执行 /reload-plugins」。
