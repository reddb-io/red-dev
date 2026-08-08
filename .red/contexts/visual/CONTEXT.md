# Context: visual

Visual system — themes, fonts, wallpapers, and the ownership of the configs that apply them.

## Redwall

The theme's wallpaper with live machine state drawn over it. The brand art underneath is unchanged — Redwall composes on top of it, never in place of it, which is what keeps it compatible with the decision that the desktop carries the mark. It reaches two surfaces from one image: the desktop background and the lock screen. What it carries is state a person reads at a glance without unlocking — the count of active Workers, and the address this machine answers on.

A Redwall is derived, never authored: the wallpaper is the source and the Redwall is regenerated whenever the state it displays changes. It therefore lives apart from the wallpapers, which are immutable per theme and content-addressed; a Redwall that shared that directory would make "retired" and "chosen by hand" indistinguishable to the sweep.

## Config ownership modes

Every configuration file touched by an adapter declares a mode: `owned` (red-dev owns and converges it), `merged` (red-dev manages only explicitly-owned fields), `adopted` (pre-existing; red-dev took over management with consent and a plan), or `external` (red-dev never touches it; at most themes it when present). Editors follow the *adoptable starter* model: install when absent, never overwrite what exists.
