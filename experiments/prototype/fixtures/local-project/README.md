# 首次 Web 试用的多文件 Lean 输入

这三份输入来自 2026-10-27 的小型试用，是经独立 Lean 4.22.0 复编核对的自建测试材料，用于复现 `Congruence.lean` 导入 `Positive.lean` 和 `ModEq.lean` 的本地依赖关系。

集成测试只将这些 `.lean` 文件复制到新建的 `prototype-project-*` 目录；不会复制旧 `.olean`、`.dsh` 或 `FlatCheck.lean`，也不写回用户试用工作区。`Congruence.lean` 注释中的单文件核验限制是历史背景；测试要求直接核验原多文件工程。

源文件 SHA-256：

- `Positive.lean`：`8807bd1c799df4dc8d8c0849d32f9b2b2f04afe5612aa08d0ea0b4218254afa8`
- `ModEq.lean`：`c74c93348dad617499583459a8a8dd883f294a96090fcd4035ce69e7357428a1`
- `Congruence.lean`：`390d378e1202716df30e670227138534e33845bd0de2585a8f7b4c4da51a69e9`
