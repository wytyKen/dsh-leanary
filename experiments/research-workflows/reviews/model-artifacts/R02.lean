import Init.Data.Int

/-- For a positive divisor `b`, the remainder `a % b` lies in `[0, b)`. -/
theorem remainder_range (a b : Int) (hb : 0 < b) :
    0 ≤ a % b ∧ a % b < b := by
  refine ⟨?_, ?_⟩
  · -- lower bound: `Int.emod_nonneg` only needs `b ≠ 0`
    exact Int.emod_nonneg a (Int.ne_of_gt hb)
  · -- upper bound: `Int.emod_lt_of_pos` takes the positivity hypothesis directly
    exact Int.emod_lt_of_pos a hb

#check remainder_range
#print axioms remainder_range
