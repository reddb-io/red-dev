# Context: visual

Visual system — themes, fonts, wallpapers, and the ownership of the configs that apply them.

## Redwall

The theme's wallpaper with live machine state drawn over it. The brand art underneath is unchanged — Redwall composes on top of it, never in place of it, which is what keeps it compatible with the decision that the desktop carries the mark. It reaches two surfaces from one image: the desktop background and the lock screen. What it carries is state a person reads at a glance without unlocking — active Workers, queue and capacity, GitHub budget, the address this machine answers on, and the current year's progress. Year progress is a week-column grid of day squares plus a continuous bar; elapsed days use the theme signal, today uses strong ink, and future days stay muted.

A Redwall is derived, never authored: the wallpaper is the source and the Redwall is regenerated whenever the state it displays changes. It therefore lives apart from the wallpapers, which are immutable per theme and content-addressed; a Redwall that shared that directory would make "retired" and "chosen by hand" indistinguishable to the sweep.

Redwall is part of the default desktop experience. A missing preference means on; boolean `false` is the durable opt-out and later converges preserve it.

## Config ownership modes

Every configuration file touched by an adapter declares a mode: `owned` (red-dev owns and converges it), `merged` (red-dev manages only explicitly-owned fields), `adopted` (pre-existing; red-dev took over management with consent and a plan), or `external` (red-dev never touches it; at most themes it when present). Editors follow the *adoptable starter* model: install when absent, never overwrite what exists.
