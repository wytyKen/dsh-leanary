# Leanary：接手并核验一个数学草稿

Leanary 是面向 DeepSeek Harness 的数学研究插件，包名 `dsh-leanary`，本地版本 `0.1.0-dev.2`。试用包包含插件安装文件和一个小示例；不需要克隆开发仓库或编译 TypeScript。

本指南按 Windows、Node.js 24、DSH `0.2.1-rc.3`、Lean `4.22.0` 验证；本机 DSH 插件包管理使用 pnpm `11.1.2`。其他版本和平台尚未验收。DSH 及 Lean 由用户自行安装；示例不需要 Mathlib。

## 1. 确认环境

在终端检查：

```powershell
dsh --version
lean --version
```

文中的 `dsh` 指你的 DSH 命令入口。若使用本地 `.cmd` 启动器，在 PowerShell 中把它替换为 `& '启动器的绝对路径'`，后面的参数相同。启动 DSH 的终端应能找到 `lean`。

尚未安装时，参考 [DSH 官方说明](https://github.com/deepseek-ai/deepseek-harness)和 [Lean 官方安装指南](https://lean-lang.org/install/)。安装好 elan 后，可安装示例使用的固定工具链：

```powershell
elan toolchain install leanprover/lean4:v4.22.0
```

示例目录中的 `lean-toolchain` 会选择该版本。在示例目录再次运行 `lean --version`，应显示 `4.22.0`。

## 2. 安装到一个新的 DSH 配置

解压试用 ZIP，进入包含 `START_HERE.md`、`.tgz` 和 `example` 的目录。下面使用配置名 `leanary-trial`。

**创建命令只对尚未使用的新配置名执行一次。** `--from-default-profile` 会重置同名配置；如果这个名称已存在，换一个新名字，并在后续命令中使用相同名称。以后启动时不再带该参数。

```powershell
dsh --profile leanary-trial --from-default-profile web --help
dsh plugin --profile leanary-trial add ./dsh-leanary-0.1.0-dev.2.tgz
```

第二条命令把安装包实际安装到该配置，使用时不依赖开发目录链接。安装会使用 DSH 自己的插件包管理器；本插件不在安装时编译源码。

同一 `DSH_HOME` 下的模型认证仍由 DSH 管理。若已有有效认证，可以沿用；若界面提示缺少认证，在 DSH 的模型设置中配置。无需把 API key 写入示例、Lean 源码或本插件配置。

## 3. 打开示例并开始

保持安装包留在原处，把 `example` 目录复制到自己选择的新目录，例如你正在使用的项目内的 `.cache/workspaces/math-first-task`。这是工作目录，核验产物也会保存在这里；无需把项目资料放进 Documents 或其他外部目录。

启动新配置，并保持终端开启：

```powershell
dsh --profile leanary-trial --port 3082
```

在 DSH 中明确打开刚复制的工作目录，新建会话。不要只根据“默认工作区”标签推断路径。发送：

```text
请阅读 problem.md 和 OrderBound.lean，接手并核验这段草稿，说明已有结果和接下来可以研究什么。
```

示例研究整数 `a ≤ b` 时的 `a + b ≤ 2b`，以及等号何时成立。它用于熟悉工作流程，不考察数学难度。

## 4. 读结果，继续工作

回答应区分两条结论：不等式使用 `a ≤ b`；等号条件 `a + b = 2b ↔ a = b` 对所有整数成立。看清实际核验的是哪条命题，以及是否有未解决的问题。

想继续改变方向，可以发送：

```text
如果不再假设 a ≤ b，原来的上界还成立吗？请给出依据，并说明已有的等号条件是否仍成立。
```

正常文件操作及 Lean 执行由 DSH 的权限机制管理；工作区内修改模式已通过本机验收。沿用平常的模型与推理设置即可。模型对话会产生所选服务的 API 费用，安装、加载和本地 Lean 检查本身不调用模型。

研究记录和源码快照位于工作目录的 `.dsh/math/`。关闭后重新启动同一配置、打开同一工作区并恢复原会话，可以继续讨论。新会话也可以要求“读取这个工作区的已有研究记录，说明当前进展”；不要把新建空目录当作原工作区。

改换研究对象或前提时，agent 应重新整理当前假设，把过去的目标和方法留在历史说明中。报告应说明结论在哪些条件下成立；某个反例否定去掉前提后的普遍命题，不表示所有其他情形都会失败。

## 当前范围与常见问题

- 支持以工作区根为模块根的本地 Lean 文件及其本地导入、工具链库。任意 Lake 布局、Mathlib、外部包和远程环境尚未验收。
- Lean 核验针对明确的形式命题；它不自动保证文字问题被忠实翻译，也不等于整个研究目标已完成。目标变化不会推翻已证明的旧精确声明。
- 同一个工作区同时由一个 DSH 实例写入研究记录，避免多个进程并发修改同一任务。
- 提示找不到 `lean`：先在启动 DSH 的终端检查 Lean；安装或调整 PATH 后重启 DSH。当前示例的工具链固定为 4.22.0。
- 提示缺少模块：先确认完整复制了项目源码、DSH 打开了正确的模块根。依赖环境未就绪不能解释成数学命题被反驳。
- 提示权限或执行失败：保留具体错误，先区分正常审批与执行环境故障；插件不会自动扩大权限或修改系统 ACL。
- 端口 3082 已占用：改用空闲端口，例如 `--port 3083`，不影响任务记录。
- 安装提示 `pnpm was not found`：为 DSH 准备可用的 pnpm 并加入 PATH，再执行插件安装；无需因此编译本插件源码。

要停用插件，可用 `dsh plugin --profile leanary-trial remove dsh-leanary`；工作目录中的研究文件仍由你保存。
