/-
# 整数同余关系（仅依赖 Lean 核心库）

本文件不引入 Mathlib，只 `import Init.Data.Int`，把
`Positive.lean` 的余数范围结论用作标准代表元的依据，
建立最小可用的整数同余层：

* `ModEq b a c`（读作 `a ≡ c (mod b)`）定义为 `b ∣ c - a`；
* 它与 `Int.emod` 的关系：`a ≡ c ↔ a % b = c % b`（无 `b ≠ 0` 限制）；
* 余数是同余类中的标准代表元：`0 ≤ c < b → (a ≡ c ↔ a % b = c)`；
* 自反、对称、传递（构成 `Equivalence`），并对 `+`、`*` 同余。

定义体与 Mathlib 的 `Int.ModEq n a b := (n : ℤ) ∣ b - a` 逐字一致，
日后若引入 Mathlib，删除本地定义、改用 `Int.ModEq` 即可直接迁移。
-/
import Init.Data.Int

namespace ModArith

/-- `ModEq b a c` 读作 `a ≡ c (mod b)`，即 `b` 整除差 `c - a`。 -/
def ModEq (b a c : Int) : Prop := b ∣ c - a

/-- 差的方向可以翻转（`b ∣ c - a ↔ b ∣ a - c`）。 -/
theorem modEq_iff_dvd_sub {b a c : Int} : ModEq b a c ↔ b ∣ a - c := by
  unfold ModEq
  rw [show a - c = -(c - a) from (Int.neg_sub c a).symm, Int.dvd_neg]

/-- 同余等价于两个数的余数相等。对 `b = 0` 也成立（此时两边都退化为相等）。 -/
theorem modEq_iff_emod_eq {b a c : Int} : ModEq b a c ↔ a % b = c % b := by
  rw [modEq_iff_dvd_sub]
  constructor
  · intro h
    rw [Int.emod_eq_emod_iff_emod_sub_eq_zero]
    exact Int.dvd_iff_emod_eq_zero.mp h
  · intro h
    exact Int.dvd_iff_emod_eq_zero.mpr (Int.emod_eq_emod_iff_emod_sub_eq_zero.mp h)

/-- 标准代表元：`0 ≤ c < b`（从而 `b > 0`）时，`a ≡ c (mod b)` 当且仅当 `c` 就是 `a % b`。 -/
theorem modEq_iff_emod_eq_of_lt {b a c : Int} (hc₀ : 0 ≤ c) (hcb : c < b) :
    ModEq b a c ↔ a % b = c := by
  rw [modEq_iff_emod_eq, Int.emod_eq_of_lt hc₀ hcb]

/-- 同余于 `0` 等价于整除。 -/
theorem modEq_zero_iff_dvd {b a : Int} : ModEq b a 0 ↔ b ∣ a := by
  unfold ModEq
  rw [Int.zero_sub, Int.dvd_neg]

theorem modEq_refl (b a : Int) : ModEq b a a := by
  unfold ModEq
  rw [Int.sub_self]
  exact Int.dvd_zero b

theorem modEq_symm {b a c : Int} (h : ModEq b a c) : ModEq b c a := by
  unfold ModEq at *
  rwa [show a - c = -(c - a) from (Int.neg_sub c a).symm, Int.dvd_neg]

theorem modEq_trans {b a c d : Int} (h₁ : ModEq b a c) (h₂ : ModEq b c d) :
    ModEq b a d := by
  unfold ModEq at *
  have h : (d - c) + (c - a) = d - a := by omega
  exact h ▸ Int.dvd_add h₂ h₁

/-- 同余是等价关系。 -/
theorem modEq_equivalence (b : Int) : Equivalence (ModEq b) :=
  ⟨modEq_refl b, fun h => modEq_symm h, fun h₁ h₂ => modEq_trans h₁ h₂⟩

/-- 余数与其本身同余：`a % b ≡ a (mod b)`。 -/
theorem modEq_emod (b a : Int) : ModEq b (a % b) a := by
  unfold ModEq
  simpa [Int.neg_sub] using Int.dvd_neg.mpr (Int.dvd_emod_sub_self (x := a) (m := b))

/-- 反过来写：`a ≡ a % b (mod b)`。 -/
theorem modEq_emod_self (b a : Int) : ModEq b a (a % b) :=
  modEq_symm (modEq_emod b a)

theorem modEq_add {b a c a' c' : Int} (h₁ : ModEq b a c) (h₂ : ModEq b a' c') :
    ModEq b (a + a') (c + c') := by
  rw [modEq_iff_emod_eq] at *
  rw [Int.add_emod, h₁, h₂]
  exact (Int.add_emod c c' b).symm

theorem modEq_mul {b a c a' c' : Int} (h₁ : ModEq b a c) (h₂ : ModEq b a' c') :
    ModEq b (a * a') (c * c') := by
  rw [modEq_iff_emod_eq] at *
  rw [Int.mul_emod, h₁, h₂]
  exact (Int.mul_emod c c' b).symm

example : (7 : Int) % 3 = 1 := by decide
example : ModEq 3 7 1 := by
  rw [modEq_iff_emod_eq]
  decide

end ModArith
