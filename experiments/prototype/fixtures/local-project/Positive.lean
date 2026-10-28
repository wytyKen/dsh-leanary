import Init.Data.Int

theorem positive_remainder_range (a b : Int) (hb : 0 < b) :
    0 ≤ a % b ∧ a % b < b := by
  exact ⟨Int.emod_nonneg a (Int.ne_of_gt hb), Int.emod_lt_of_pos a hb⟩
