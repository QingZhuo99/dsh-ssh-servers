# dsh-ssh-servers

给 DeepSeek Harness 用的 SSH 服务器连接插件：像 Xshell 一样保存服务器，但**登录动作永远由人来做**，agent 只获得一条已经存在的通道。

## 它解决什么

| 需求 | 实现 |
|---|---|
| 保存服务器地址、用户名 | 服务器档案存 `$DSH_HOME/dsh-ssh-servers/profiles.json`（**不含密码**） |
| 给 agent 设置工作区 | 每个档案带一个远程工作目录，agent 的 `ssh_*` 工具默认在那里执行 |
| 由使用者选择登录 / 断开 | 只有浏览器面板能建立连接；没有、也不会有 `ssh_connect` 这类工具 |

## 用法

1. **设置 → 插件 → SSH 服务器**：添加服务器（名称、地址、端口、用户名、远程工作目录）。
2. 会话输入框上方出现一条 `SSH 未连接` 状态栏，点 **登录…**，选服务器、输密码、点 **登录**。
3. 状态栏变成绿色并显示 `label (user@host) + 远程工作目录`。此时 agent 可以用 `ssh_*` 工具。
4. 点 **全部断开** 结束会话；连接关闭后 agent 的远程工具立即失效。

## 交给 agent 的工具

| 工具 | 作用 |
|---|---|
| `ssh_status` | 只读：列出已保存的服务器与当前已打开的连接 |
| `ssh_exec` | 在已连接服务器上执行非交互式命令 |
| `ssh_read_file` | 读远程文本文件（本机 `read` 的远程对应物） |
| `ssh_write_file` | 写远程文件（内容走 base64，避免 shell 改写） |
| `ssh_list_dir` | 列远程目录（本机 `glob` 的远程对应物） |

未连接时这些工具会失败并明确提示"需要使用者先登录"——它们不会、也无法自行发起连接。

## 密码去了哪里

这是本插件最需要说清楚的一件事。密码的完整生命周期：

```
浏览器密码框 --POST body--> Host 进程内存 --一次 SSH 认证--> 丢弃
```

- **不写盘**：服务器档案里没有密码字段，存储层在写入前会丢弃任何多余字段。
- **不进进程参数**：不使用 `ssh.exe`，因此密码不会出现在任何命令行里被 `Win32_Process` 之类的接口看到。
- **不进环境变量**：SSH 由进程内的 `ssh2` 库直接完成协议握手。
- **不回传**：任何 HTTP 响应里都不含密码。
- **用完即弃**：认证成功后引用被显式置空，连接靠长连接维持，不需要再次认证。

## 安全边界（请连同上一节一起读）

**能守住的**：agent 拿不到密码 ⇒ 即使它去调用本插件的 `connect` 端点，也没有凭据可用 ⇒ "只有人能登录"是由密码而非按钮可见性保证的。

**守不住的，如实列出**：

1. **agent 本来就有 shell 工具。** 它可以自己执行 `ssh user@host`。本插件限制的是"通过本插件登录"，不是"禁止 agent 使用 SSH"。要真正限制，需要收窄 agent 的 shell 权限。
2. **同用户进程可读 Host 内存。** 有调试权限的同用户进程理论上能取走内存中的密码。这是进程隔离问题，不是本插件能解决的。
3. **连接端点对 agent 可见。** 端点只做 loopback + Origin 校验，agent 也能伪造。防线是密码，不是端点。
4. **远程侧不受本机沙箱约束。** agent 在服务器上能做什么，只由那个 SSH 账号的权限决定。
5. **断开不保证杀掉远程进程。** SSH 通道关闭后，远程已启动的后台进程是否存活取决于它自己（`nohup`/`tmux` 之类）。本插件不主动清理。
6. **没有 TTY。** `sudo` 提示、`top`、`vim` 这类需要终端的命令无法工作。

**留痕**：每次连接/断开尝试都会记录（时间、服务器、结果），并显示在登录面板的"最近登录记录"里。如果有人——包括 agent——在你不知情时尝试连接，你能看到。

## 主机密钥

首次连接采用 trust-on-first-use：指纹记录进档案。**之后指纹变化会直接拒绝连接**，不会静默接受，因为这正是"服务器可能不是你以为的那台"的信号。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add github:QingZhuo99/dsh-ssh-servers
```

也可以指向本地目录（开发时更方便）：

```sh
dsh plugin --profile web add /path/to/dsh-ssh-servers
```

包需要出现在 profile 的 `dsh.profile.bundles` 里才会被装载（`dsh plugin add` 会同时维护依赖和该列表）。

装好后需要重启 DSH。

> 已安装的副本是**拷贝**而非符号链接，所以改完源码必须重新安装/重新拷贝，并且重启才会生效。

## 回滚

1. 从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 中删除 `"dsh-ssh-servers"`，并从 `dependencies` 删除对应行。
2. 删除 `~/.dsh/profiles/web/node_modules/dsh-ssh-servers`。
3. 重启 DSH。

服务器档案保存在 `$DSH_HOME/dsh-ssh-servers/profiles.json`，回滚插件不会删除它；里面没有密码，只有地址、用户名和工作目录。

## 已知限制

- `ssh_write_file` 的 base64 解码优先用 GNU 的 `base64 -d`，失败时回退到 BSD 的 `base64 -D`；两者都不支持的极小众环境需要改用别的方式。
- 命令输出截断上限 512 KiB。
- 默认命令超时 120 秒。
- 同一 profile 重复登录会先关掉旧连接。

## 兼容性

浏览器半边使用的是 DSH 内部契约——`window.__ModuleLoader__.load(...)` 的模块格式、`conversation.input.dock` 与 `settings.plugin.item` 两个 Slot、以及 `package.json` 里 `dsh.client.inject` 的声明方式。**这些不是稳定的公开 API**，DSH 升级后可能失效；升级后如果面板不见了，先查这三处。

实测环境：

| 项目 | 版本 |
|---|---|
| DSH | 0.1.1-rc.2 |
| Cordis | 4.0.1 |
| Node | ≥ 22.19（见 `package.json` 的 `engines`） |
| 界面 | Web 面（`dsh web`） |
| 主机侧 | Windows / Linux 均可 |

Host 半边的 HTTP 路由注册在 `ctx.inject(['webServer'], …)` 作用域里：没有 webServer 服务的 headless profile 不会因此报错或卡住，只是没有浏览器面板可供登录。

## 许可

MIT，见 `LICENSE`。
