import Init.Data.Int

namespace OrderBound

/-- Under `a ≤ b`, the sum is at most twice the right endpoint. -/
theorem ordered_sum_le_double (a b : Int) (hab : a ≤ b) :
    a + b ≤ 2 * b := by
  omega

/-- The equality condition holds for all integers, even without `a ≤ b`. -/
theorem sum_eq_double_iff (a b : Int) :
    a + b = 2 * b ↔ a = b := by
  omega

end OrderBound
