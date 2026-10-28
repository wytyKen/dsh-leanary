/-
# 同余层的扩展：算术封闭 + 标准代表元

本文件是叠加在 `Positive.lean` 与 `ModEq.lean` 之上的第三层，**真正 import 了两者**：

* `Positive`：`positive_remainder_range`（`0 < b → 0 ≤ a % b ∧ a % b < b`）
* `ModEq`：`ModArith.ModEq` 及其基本性质

内容：
1. 同余对 `-`（取负）、二元 `-`、`^` 封闭，以及对称写法 `modEq_comm`；
2. 标准代表元的存在唯一性 `existsUnique_representative`：
   存在性直接用 `positive_remainder_range`，唯一性用 `modEq_iff_emod_eq_of_lt`。

关于证据：单文件校验器 `math_verify` 会把源文件单独快照到临时目录再
`import` 该模块，因此跨文件 `import` 的模块无法被它直接核验。本文件的机器
证据是 `lean` 的全量编译与 `#print axioms`（需把当前目录加入搜索路径）：

```
lean -o Positive.olean Positive.lean
lean -o ModEq.olean ModEq.lean
$env:LEAN_PATH = "."          # PowerShell；bash 用 export LEAN_PATH=.
lean Congruence.lean
```
-/
import Positive
import ModEq

namespace ModArith

/-- 同余的对称写法。 -/
theorem modEq_comm {b a c : Int} : ModEq b a c ↔ ModEq b c a :=
  ⟨modEq_symm, modEq_symm⟩

/-- 同余对取负封闭：`a ≡ c → -a ≡ -c`。 -/
theorem modEq_neg {b a c : Int} (h : ModEq b a c) : ModEq b (-a) (-c) := by
  have h' : b ∣ a - c := modEq_iff_dvd_sub.mp h
  rw [modEq_iff_dvd_sub]
  have key : (-a) - (-c) = c - a := by omega
  rw [key]
  simpa [Int.neg_sub] using Int.dvd_neg.mpr h'

/-- 同余对减法封闭。 -/
theorem modEq_sub {b a c a' c' : Int} (h₁ : ModEq b a c) (h₂ : ModEq b a' c') :
    ModEq b (a - a') (c - c') := by
  have h := modEq_add h₁ (modEq_neg h₂)
  simpa [Int.sub_eq_add_neg] using h

/-- 同余对幂封闭。 -/
theorem modEq_pow {b a c : Int} (h : ModEq b a c) (n : Nat) :
    ModEq b (a ^ n) (c ^ n) := by
  induction n with
  | zero => simpa using modEq_refl b 1
  | succ n ih => simpa [Int.pow_succ'] using modEq_mul h ih

/-- 唯一存在量词。Lean core 不提供 `∃!` 与 `ExistsUnique`（二者在 Mathlib 中），
故此处给出等价的局部定义；放在 `ModArith` 命名空间内以免日后与 Mathlib 冲突。 -/
def ExistsUnique {α : Sort u} (p : α → Prop) : Prop := ∃ x, p x ∧ ∀ y, p y → y = x

/-- 标准代表元：`0 < b` 时，每个整数在同余类中恰有一个 `[0, b)` 内的代表元。 -/
theorem existsUnique_representative {a b : Int} (hb : 0 < b) :
    ExistsUnique fun r : Int => 0 ≤ r ∧ r < b ∧ ModEq b a r := by
  refine ⟨a % b, ⟨(positive_remainder_range a b hb).1,
    (positive_remainder_range a b hb).2, modEq_emod_self b a⟩, ?_⟩
  rintro r ⟨hr₀, hrb, hr⟩
  exact ((modEq_iff_emod_eq_of_lt hr₀ hrb).mp hr).symm

end ModArith
