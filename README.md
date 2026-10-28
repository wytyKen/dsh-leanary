# Leanary

**面向 DeepSeek Harness 的数学研究插件**  
*A mathematical research plugin for DeepSeek Harness*

一个供 DeepSeek Harness 使用的本地数学研究雏形：用户用自然语言给出问题或草稿，agent 接手、保存研究进展，并用 Lean 核验明确的形式命题。人确定研究方向，agent 推进具体工作。

正式名称为 **Leanary**，包名为 `dsh-leanary`，版本 `0.1.0-dev.2`。`private: true` 用于防止误发布到 npm，与 GitHub 源码仓库是否公开独立；公开时机由维护者决定。

## 独立试用

优先阅读[上手说明](docs/QUICKSTART.md)。试用 ZIP 包含安装用的 `.tgz`、`START_HERE.md` 和一个可复制到新工作区的 `example`，不依赖本项目开发目录的链接。

已验证环境为 Windows、Node.js 24、DSH `0.2.1-rc.3` 和 Lean `4.22.0`。模型认证由 DSH 提供；插件不另建模型客户端。安装和本地 Lean 检查不启动模型，对话使用所选模型服务并产生其 API 费用。

## 可以做什么

- 接手已有文字草稿及 Lean 文件，保存目标、假设、候选结论和下一步。
- 核验命题的完整类型与传递公理，保留实际命令、源码及本地导入依赖的快照。
- 继续原任务，识别源码或依赖变化；保留旧证明，并说明它与新目标的关系。

Lean 通过仅说明相应形式命题通过核验，自然语言的忠实对应和整个研究目标的完成仍需要解释。当前支持工作区本地模块及工具链库；大型 Mathlib、任意 Lake 布局、远程运行和长期自动研究尚未验收。

同一工作区同时由一个 DSH 实例写入研究记录；当前不承诺多个进程同时修改同一任务的事务性。

## 示例

[整数不等式草稿](examples/order-bound/README.md)包含两个小结果和自然语言提示，用来熟悉接手、核验、改变目标的流程，不增加数学难度。

## 开发

源仓库中使用 `pnpm run typecheck`、`pnpm test` 检查代码，`pnpm run trial:pack` 在 Windows 上构建试用 ZIP。真实 Lean 与原生沙箱检查须按[开发说明](docs/DEVELOPMENT.md)显式启用。试用者无需运行开发检查。

原始调研、本机配置及完整运行档案保留在开发工作区，不是构建本源码或使用安装包的前提。拟公开源码的文件范围由 `source-release.json` 指定，包含测试所需的小型自建输入。
