# Context: visual

Visual system — themes, fonts, wallpapers, and the ownership of the configs that apply them.

## Config ownership modes

Every configuration file touched by an adapter declares a mode: `owned` (red-dev owns and converges it), `merged` (red-dev manages only explicitly-owned fields), `adopted` (pre-existing; red-dev took over management with consent and a plan), or `external` (red-dev never touches it; at most themes it when present). Editors follow the *adoptable starter* model: install when absent, never overwrite what exists.
