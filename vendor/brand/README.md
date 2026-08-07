# vendor/brand

A byte-identical copy of `tokens/tokens.json` from
[reddb-io/brand](https://github.com/reddb-io/brand), pinned in
`brand.lock.json`.

## Why a copy and not a dependency

The brand publishes no package. `package.json` there is `private`, version
`0.0.0`, with no `exports` and no build. Its ADR 0003 says the distribution unit
is an Assets release *"taken whole by copy and paste"*, and ADR 0006 documents
the only consumer pattern there is: vendor the release, alias rather than
replace, reconcile drift one token per diff.

## Why the whole file and not the sixteen values

`src/themes.ts` already recorded the verdict on transcription, about a different
palette:

> Palettes taken from omakub's own alacritty.toml for each theme, generated
> rather than transcribed: 112 hex values copied by hand is a guaranteed typo,
> and a wrong one is invisible until someone notices their terminal's blue is
> slightly off.

Sixteen is not meaningfully safer than a hundred and twelve.

The whole file is 10 KB, and carrying it whole buys something a distillation
cannot: the `$extensions.reddb.contrastGuardrail` blocks come with it, so the
brand's own contrast audit runs inside red-dev's test suite against red-dev's
own copy. A re-vendor that changes a colour without changing the declared
guardrail fails `bun test` here — which is exactly what the brand intends when
it says *"a guardrail that lies fails the build"*.

## Re-vendoring

```
bun run scripts/vendor-brand.ts --brand ../brand
```

It refuses to run against a dirty brand working tree, records `HEAD` in the
lock, and prints one line per changed resolved colour so the reconciliation ADR
0006 asks for is what the tool actually produces.

**Never edit `tokens/tokens.json` here.** New brand values are added in the
brand repo, never in a consumer — also ADR 0006. A local value red-dev needs and
the brand has not decided belongs in `src/terminal-palette.ts`, marked as a
local override with the upstream issue beside it.
