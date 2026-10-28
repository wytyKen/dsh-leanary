# Leanary 开发与本地验证

本地版本 `0.1.0-dev.2`。开发使用 Node.js 24、pnpm 11.1.2；DSH 兼容版本固定为 `0.2.1-rc.3`，真实数学控制使用 Lean 4.22.0。`private: true` 防止误发布 npm，不阻止源码仓库采用 MIT 公开。

## 构建和测试

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

未指定 Lean 时，真实 Lean 项会跳过，不能把它们写成通过。启用时将变量设置为已经安装的 Lean 可执行文件；例如 PATH 上已有固定工具链的入口：

```powershell
$env:DSH_MATH_TEST_LEAN = (Get-Command lean).Source
pnpm test
```

运行前确认该命令使用 Lean 4.22.0。测试自建工作目录放在项目 `.cache/` 下，不要求模型 API。

两个真实 Windows 沙箱测试默认跳过，需已配置 DSH 本地运行环境后显式启用：

```powershell
$env:DSH_NATIVE_SANDBOX_TEST = '1'
node --test tests/native-sandbox.test.mjs tests/local-project-native.test.mjs
```

这两份脚本保留了原开发机 DSH 专用临时根的缺省值；在其他安装位置使用前，通过 `DSH_SMOKE_TEMP` 指向自己的已有 DSH 临时目录，通过 `DSH_SMOKE_LEAN` 指向已安装的 Lean。它们会在新建的项目工作区执行原生权限授予和检查，不读取密钥或调用模型，不适合在未准备好的环境直接运行。

公开源码候选保留测试所需的小型自建输入：`experiments/prototype/fixtures/local-project/` 与 `experiments/research-workflows/reviews/model-artifacts/R02.lean`。这些是输入文件；原始会话、诊断、核验产物和第三方适配实验不随源码候选分发。

## 研究记录的语义

目标修订里的 assumptions 是当前数学对象与前提的完整列表，不是逐轮追加的工作日志。改变研究对象时应重新整理它；旧目标、方法和历史证明仍保留在对应修订或 notes。程序不自动推断自然语言假设是否等价。

`formal_type` 在导入被核验模块后，于探针自己的顶层上下文解释。自定义定义要用全限定名，例如 `Example.RecordedLaw`，并明确绑定类型、实例和前提；不沿用源文件局部的 namespace、open 或 notation。名称解释错误会保留失败回执，应纠正类型后另登记 claim，不将其解释为数学反例。

研究文件使用 DSH 原生文件版本检查与工作区策略。同一工作区同时由一个 DSH 实例写入；没有跨进程数据库事务保证。核验信任已安装 Lean 与工具链，归档本地源码闭包，不完整归档工具链、外部包或任意构建环境，也不审计任意恶意 Lean 元程序。

## 构建交付物

Windows 下运行 `pnpm run trial:pack`，会在 `artifacts/trials/` 创建新的插件 tar 和试用 ZIP。`node scripts/check-distribution.mjs <绝对.tgz路径>` 检查包内入口、导入、链接和文件清单。独立安装步骤见 [QUICKSTART.md](QUICKSTART.md)。

项目文档、示例、实验、安装包和专用临时资料默认保留项目内。DSH、Lean/elan、Node 及包管理器正常维护的配置、凭据、会话和共享缓存沿用其安装位置。不要把真实密钥或原始模型思考流放进源码候选或试用包。
