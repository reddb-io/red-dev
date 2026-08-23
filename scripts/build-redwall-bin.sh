#!/usr/bin/env bash
# Build the Redwall renderer as a standalone native binary using scriptc.
#
# Why a separate script: the redwall rendering (TTF parsing + PNG codec)
# is the hot path during `red-dev redwall`, and shipping it inside the
# 82 MB Bun-compiled red-dev binary wastes 80 MB of RSS per repaint.
# A scriptc build is 1.8 MB with ~4 MB resident and ~10 ms cold start.
#
# This script copies the rendering modules to a build directory, applies
# the scriptc-specific tweaks, and produces `dist/redwall-bin/redwall`.

set -euo pipefail

# Resolve the repo root (the directory holding this script's parent's parent).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/.red/tmp/redwall-build"
OUTPUT="${REPO_ROOT}/vendor/redwall-bin/redwall"
ENTRY="${REPO_ROOT}/scripts/redwall-bin-main.ts"

if ! command -v scriptc >/dev/null 2>&1; then
  echo "error: scriptc not installed. Run: npm install -g scriptc" >&2
  exit 1
fi

mkdir -p "${BUILD_DIR}/src" "${BUILD_DIR}/assets/wallpapers" "${BUILD_DIR}/assets/fonts" "${BUILD_DIR}/vendor/brand/tokens"

cp "${REPO_ROOT}/src/redwall-render.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/src/png.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/src/brand.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/src/redwall-charset.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/src/redwall-font.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/src/themes.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/src/ttf.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/src/typeset.ts" "${BUILD_DIR}/src/"
cp "${REPO_ROOT}/vendor/brand/tokens/tokens.json" "${BUILD_DIR}/vendor/brand/tokens/"
cp "${REPO_ROOT}/assets/wallpapers/"*.png "${BUILD_DIR}/assets/wallpapers/"
cp "${REPO_ROOT}/assets/fonts/redwall-firacode-subset.ttf" "${BUILD_DIR}/assets/fonts/"
cp "${ENTRY}" "${BUILD_DIR}/src/main.ts"

cat > "${BUILD_DIR}/src/agent-usage.ts" <<'EOF'
export interface AgentUsageWindow { readonly kind: string; readonly remainingPercent: number; }
export interface AgentUsageReading { readonly provider: string; readonly windows: readonly AgentUsageWindow[]; }
EOF

cat > "${BUILD_DIR}/src/host-state.ts" <<'EOF'
export type HostStateAttentionKind = "births-paused" | "admission-refused" | "worker-shortfall" | "memory-overcommitted" | "workers-unisolated" | "update-available";
export interface HostStateAttention { readonly kind: HostStateAttentionKind; readonly count: number | null; }
EOF

cat > "${BUILD_DIR}/package.json" <<'EOF'
{ "name": "redwall-bin", "private": true, "type": "module" }
EOF

# Apply the scriptc-specific tweaks documented in the entry script.
python3 - "${BUILD_DIR}/src" <<'PYEOF'
import re, sys, pathlib
root = pathlib.Path(sys.argv[1])

# brand.ts: replace `with { type: "json" }` with a runtime read.
brand = root / "brand.ts"
brand_text = brand.read_text()
brand_text = brand_text.replace(
    'import tokens from "../vendor/brand/tokens/tokens.json" with { type: "json" };',
    'import { readFileSync } from "node:fs";\nconst _tokensJson = readFileSync("./vendor/brand/tokens/tokens.json", "utf8");\nconst tokens: Record<string, unknown> = JSON.parse(_tokensJson) as Record<string, unknown>;',
)
# Replace `let cursor: unknown = tokens;` with the typed cursor.
brand_text = brand_text.replace("let cursor: unknown = tokens;", "let cursor: Record<string, unknown> | string | number | boolean = tokens;")
# Walk the typed cursor explicitly so scriptc sees Record<string, unknown>.
brand_text = brand_text.replace(
    "type Node = Record<string, unknown>;",
    "type Node = Record<string, string | number | boolean | Record<string, string | number | boolean>>;",
)
brand_text = brand_text.replace(
    "function nodeAt(path: TokenPath): Node | undefined {\n  let cursor: Record<string, unknown> | string | number | boolean = tokens;\n  for (const part of path.split(\".\")) {\n    if (typeof cursor !== \"object\" || cursor === null) return undefined;\n    const asRecord = cursor as Record<string, unknown>;\n    const next: string | number | boolean | Record<string, unknown> | null = asRecord[part] as string | number | boolean | Record<string, unknown> | null;\n    if (next === null) return undefined;\n    cursor = next;\n  }\n  return typeof cursor === \"object\" && cursor !== null ? (cursor as Node) : undefined;\n}",
    "function nodeAt(path: TokenPath): Node | undefined {\n  let cursor: Node | string | number | boolean = tokens as Node;\n  for (const part of path.split(\".\")) {\n    if (typeof cursor !== \"object\" || cursor === null) return undefined;\n    const next: string | number | boolean | Node = (cursor as Record<string, string | number | boolean | Node>)[part];\n    if (typeof next !== \"string\" && typeof next !== \"number\" && typeof next !== \"boolean\" && (typeof next !== \"object\" || next === null)) return undefined;\n    cursor = next;\n  }\n  return typeof cursor === \"object\" && cursor !== null ? (cursor as Node) : undefined;\n}",
)
# The brand declaration walks require casts through unknown; scriptc is
# strict about conversions between unrelated types, so route them via
# unknown first.
brand_text = re.sub(
    r" as (string\[\])\)",
    r" as unknown as \1)",
    brand_text,
)
# Patch the cursor walk to use a cast that the scriptc type-checker accepts.
brand_text = brand_text.replace(
    "cursor = (cursor as Node)[part];",
    "cursor = (cursor as unknown as Record<string, Node | string | number | boolean>)[part] ?? \"\";",
)
# Replace the whole brand module with a render-only minimum. The Redwall
# renderer never reads tokens — themes are resolved by the caller and
# arrive as `Theme` objects with hex strings — so a brand module that
# only exposes `rgb`, plus the `red` and `neutral` ramps that themes.ts
# indexes into, is enough.
brand.write_text(
    'export type Hex = string;\n'
    'export const red = {\n'
    '  400: "#ff6389",\n'
    '  500: "#ff2056",\n'
    '  600: "#d11a46",\n'
    '  700: "#ad163a",\n'
    '} as const;\n'
    'export const neutral = {\n'
    '  0: "#ffffff",\n'
    '  50: "#f4f5f7",\n'
    '  100: "#e7e9ee",\n'
    '  200: "#d3d6de",\n'
    '  300: "#b3b8c4",\n'
    '  400: "#8b91a1",\n'
    '  500: "#666d7e",\n'
    '  600: "#4a5162",\n'
    '  700: "#333949",\n'
    '  800: "#1e222d",\n'
    '  900: "#12141b",\n'
    '  950: "#07080a",\n'
    '} as const;\n'
    'export function rgb(hex: Hex): [number, number, number] {\n'
    '  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());\n'
    '  if (!m) throw new Error(`not a hex colour: ${hex}`);\n'
    '  return [\n'
    '    parseInt(m[1] as string, 16),\n'
    '    parseInt(m[2] as string, 16),\n'
    '    parseInt(m[3] as string, 16),\n'
    '  ];\n'
    '}\n'
)
# Replace the unknown-typed token loop with explicit type narrowing.
brand_text = brand_text.replace(
    "const value = node?.[\"$value\"];\n\n    if (typeof value === \"string\") {\n      const alias = /^\\{(.+)\\}$/.exec(value.trim())?.[1];\n      if (!alias) throw new Error(`brand token ${at} is a string but not an alias: ${value}`);\n      at = alias;\n      continue;\n    }\n\n    if (typeof value === \"object\" && value !== null) {\n      const hex = (value as Node)[\"hex\"];\n      if (typeof hex === \"string\") return hex.toLowerCase();\n    }",
    "const value: string | Record<string, unknown> | undefined = node?.[\"$value\"] as string | Record<string, unknown> | undefined;\n\n    if (typeof value === \"string\") {\n      const alias = /^\\{(.+)\\}$/.exec(value.trim())?.[1];\n      if (!alias) throw new Error(`brand token ${at} is a string but not an alias: ${value}`);\n      at = alias;\n      continue;\n    }\n\n    if (typeof value === \"object\" && value !== null) {\n      const hex: string | undefined = value[\"hex\"] as string | undefined;\n      if (typeof hex === \"string\") return hex.toLowerCase();\n    }",
)
# Discard the rewritten brand_text; we replace the whole module below.
brand_text = None

# redwall-font.ts: replace `with { type: "file" }` with a runtime read.
font = root / "redwall-font.ts"
font.write_text(font.read_text().replace(
    'import subset from "../assets/fonts/redwall-firacode-subset.ttf" with { type: "file" };\n\n/** Path to the embedded subset, for `Bun.file()`. */\nexport const REDWALL_SUBSET: string = subset;',
    'import { readFileSync } from "node:fs";\nconst subsetBytes = readFileSync("./assets/fonts/redwall-firacode-subset.ttf");\nexport const REDWALL_SUBSET: string = "./assets/fonts/redwall-firacode-subset.ttf";\nexport const REDWALL_SUBSET_BYTES: Uint8Array = subsetBytes;',
))

# png.ts: SIGNATURE as Uint8Array, deflateSync without options
png = root / "png.ts"
png_text = png.read_text()
png_text = png_text.replace(
    'const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;',
    'const SIGNATURE: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);',
)
png_text = png_text.replace(
    'deflateSync(filtered(data, width, height), { level: 9 })',
    'deflateSync(filtered(data, width, height))',
)
png.write_text(png_text)

# typeset.ts: replace Float64Array with number[], Math.hypot with inline,
# Math.round/Math.max/Math.min with inline equivalents, codePointAt inline.
typeset = root / "typeset.ts"
ts_text = typeset.read_text()
ts_text = ts_text.replace(
    "const coverage = new Float64Array(width * height);",
    "const coverage: number[] = []; for (let _ci = 0; _ci < width * height; _ci++) coverage.push(0);",
)
ts_text = ts_text.replace("coverage: Float64Array", "coverage: number[]")
ts_text = ts_text.replace("Math.hypot(b.x - a.x, b.y - a.y)", "hypot2(b.x - a.x, b.y - a.y)")
# .toString(16) on numbers in the throw path
ts_text = ts_text.replace(
    "codepointAt(ch, 0).toString(16).toUpperCase().padStart(4, \"0\")",
    "hexPad(codepointAt(ch, 0))",
)
# Math.sqrt in the hypot helper — replace the inline Math.sqrt with one
# the helpers block also defines.
ts_text = ts_text.replace("Math.sqrt(1 + r * r)", "sqrt(1 + r * r)")
# Number.parseInt -> parseInt
ts_text = re.sub(r"\bNumber\.parseInt\(", "parseInt(", ts_text)
ts_text = ts_text.replace("Math.max(2, Math.min(32, Math.ceil(span)))", "max2(2, min2(32, ceilFloor(span)))")
ts_text = ts_text.replace("Math.max(width, lineWidth(font, line, scale))", "max2(width, lineWidth(font, line, scale))")
ts_text = ts_text.replace("Math.max(1, Math.ceil(metrics.width))", "max2(1, ceilFloor(metrics.width))")
ts_text = ts_text.replace("Math.max(1, Math.ceil(metrics.height))", "max2(1, ceilFloor(metrics.height))")
ts_text = ts_text.replace("Math.min(edge.y0, edge.y1)", "min2(edge.y0, edge.y1)")
ts_text = ts_text.replace("Math.max(edge.y0, edge.y1)", "max2(edge.y0, edge.y1)")
ts_text = ts_text.replace("Math.min(255, Math.round(coverage[i]! * 255))", "min2(255, roundTo(coverage[i]! * 255))")
ts_text = ts_text.replace("Math.max(from, 0)", "max2(from, 0)")
ts_text = ts_text.replace("Math.min(to, width)", "min2(to, width)")
ts_text = ts_text.replace("Math.max(1, Math.min(days, elapsed))", "max2(1, min2(days, elapsed))")
ts_text = ts_text.replace("new Date(year, 1, 29).getMonth() === 1 ? 366 : 365", "isLeapYear(year) ? 366 : 365")
ts_text = ts_text.replace("firstWeekday: new Date(year, 0, 1).getDay()", "firstWeekday: firstWeekdayOf(year)")
ts_text = ts_text.replace('ch.codePointAt(0)!', 'codepointAt(ch, 0)')
# After substitution the throw expression reads codepointAt(ch, 0).toString(16)...
ts_text = ts_text.replace(
    "codepointAt(ch, 0).toString(16).toUpperCase().padStart(4, \"0\")",
    "hexPad(codepointAt(ch, 0))",
)
ts_text = ts_text.replace("(...REDWALL_LABELS.join(\"\"), ...REDWALL_VALUES)", "...")
# Object spread on addContour
ts_text = ts_text.replace(
    "const points = contour.map((p) => ({ ...place(p.x, p.y), on: p.on }));",
    "const points: Array<{ x: number; y: number; on: boolean }> = contour.map((p) => { const placed = place(p.x, p.y); return { x: placed.x, y: placed.y, on: p.on }; });",
)
ts_text = ts_text.replace("crossings.length = 0;", "while (crossings.length > 0) crossings.pop();")
# Append the inline helpers after the imports.
helpers = '''

function max2(a: number, b: number): number { return a > b ? a : b; }
function min2(a: number, b: number): number { return a < b ? a : b; }
function hypot2(dx: number, dy: number): number {
  const x = dx < 0 ? -dx : dx;
  const y = dy < 0 ? -dy : dy;
  const lo = x < y ? x : y;
  const hi = x < y ? y : x;
  if (hi === 0) return 0;
  const r = lo / hi;
  return hi * sqrt(1 + r * r);
}
function sqrt(v: number): number { if (v <= 0) return 0; let x = v; for (let i = 0; i < 16; i++) x = 0.5 * (x + v / x); return x; }
function hexDigit(i: number): string { return "0123456789ABCDEF".charAt(i); }
function hexPad(v: number): string {
  const h = (v >> 12) & 0xf; const m = (v >> 8) & 0xf; const l = (v >> 4) & 0xf; const x = v & 0xf;
  return hexDigit(h) + hexDigit(m) + hexDigit(l) + hexDigit(x);
}
function ceilFloor(v: number): number { const f = Math.floor(v); return f === v ? f : f + 1; }
function roundTo(v: number): number { return Math.floor(v + 0.5); }
export function codepointAt(text: string, index: number): number {
  const c = text.charCodeAt(index);
  if (c >= 0xd800 && c <= 0xdbff && index + 1 < text.length) {
    const t = text.charCodeAt(index + 1);
    if (t >= 0xdc00 && t <= 0xdfff) return 0x10000 + ((c - 0xd800) << 10) + (t - 0xdc00);
  }
  return c;
}
'''
ts_text += helpers
typeset.write_text(ts_text)

# redwall-render.ts: spread arrays into .push, type predicates, new Date(3 args),
# Math.max with mixed spread/positional, readonly array.join.
render = root / "redwall-render.ts"
render_text = render.read_text()
# Number.parseInt -> parseInt (scriptc has parseInt in stdlib but not Number.parseInt)
render_text = re.sub(r"\bNumber\.parseInt\(", "parseInt(", render_text)
# Math.hypot -> _hypot2 (helper appended at the end)
render_text = render_text.replace("Math.hypot(dx, dy)", "_hypot2(dx, dy)")
# '.toString(16).padStart(...)' on numbers -> hexPad helper
render_text = render_text.replace(
    "codepointAt(ch, 0).toString(16).toUpperCase().padStart(4, \"0\")",
    "_hexPad(codepointAt(ch, 0))",
)
# 'in' with computed keys
render_text = render_text.replace(
    "lines.push(...github, ...agent);",
    "for (const l of github) lines.push(l); for (const l of agent) lines.push(l);",
)
render_text = render_text.replace(
    'return ["redskilled unavailable", ...github, ...agent, address]\n      .filter((line): line is string => line !== null);',
    'return (() => { const out: string[] = ["redskilled unavailable"]; for (const l of github) out.push(l); for (const l of agent) out.push(l); if (address !== null) out.push(address); return out.filter((line): boolean => line !== null); })();',
)
render_text = render_text.replace(
    '.filter((value): value is string => value !== null);',
    '.filter((value): boolean => value !== null) as string[];',
)
# New Date with 3 args - use Date.UTC
render_text = render_text.replace(
    "new Date(year, 1, 29).getMonth() === 1 ? 366 : 365",
    "_isLeapYear(year) ? 366 : 365",
)
render_text = render_text.replace(
    "firstWeekday: new Date(year, 0, 1).getDay()",
    "firstWeekday: new Date(Date.UTC(year, 0, 1)).getUTCDay()",
)
# Append the leap-year helper to the render file (no `unknown` issues there).
render_text += "\nfunction _isLeapYear(year: number): boolean { return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0; }\nfunction _hypot2(dx: number, dy: number): number { const x = dx < 0 ? -dx : dx; const y = dy < 0 ? -dy : dy; const lo = x < y ? x : y; const hi = x < y ? y : x; if (hi === 0) return 0; const r = lo / hi; return hi * _sqrt(1 + r * r); }\nfunction _sqrt(v: number): number { if (v <= 0) return 0; let x = v; for (let i = 0; i < 16; i++) x = 0.5 * (x + v / x); return x; }\n"
def _maxRewrite(args_text):
    """Convert a Math.max(a, ...arr, b, c, d) call into manual max."""
    parts = [p.strip() for p in args_text.split(",") if p.strip()]
    if len(parts) < 2:
        return f"Math.max({args_text})"
    initial = parts[0]
    rest = parts[1:]
    lines = [f"let contentWidth = {initial};"]
    for p in rest:
        if p.startswith("..."):
            expr = p[3:].strip()
            lines.append(f"for (const w of {expr}) contentWidth = contentWidth > w ? contentWidth : w;")
        else:
            lines.append(f"contentWidth = contentWidth > ({p}) ? contentWidth : ({p});")
    return "\n  ".join(lines)

# Math.max with mixed positional/spread → manual max. The regex needs to
# match across the whole 5-argument call (positional, spread, positional,
# positional, positional), so use a non-greedy match across newlines.
render_text = re.sub(
    r"const contentWidth = Math\.max\((.+?)\);",
    lambda m: _maxRewrite(m.group(1)),
    render_text,
    flags=re.DOTALL,
)
render.write_text(render_text)

# ttf.ts: .toString(16) on numbers, Number.parseInt
ttf = root / "ttf.ts"
ttf_text = ttf.read_text()
ttf_text = ttf_text.replace(
    'sfnt.toString(16).padStart(8, "0")',
    'hexPad8(sfnt)',
)
ttf_text = re.sub(r"\bNumber\.parseInt\(", "parseInt(", ttf_text)
# Append a pad-to-8 helper at the end of ttf.ts (8 hex chars vs the 4
# used in typeset.ts).
ttf_text += '\nfunction hexPad8(v: number): string { let out = ""; for (let i = 7; i >= 0; i--) { out += "0123456789ABCDEF".charAt((v >> (i * 4)) & 0xf); } return out; }\n'
ttf.write_text(ttf_text)

# redwall-charset.ts: readonly tuple → string[]; spread join workaround
charset = root / "redwall-charset.ts"
charset_text = charset.read_text()
charset_text = charset_text.replace(
    """] as const;""",
    "];",
    1,
)
charset_text = charset_text.replace(
    "export const REDWALL_CHARSET: string = [\n  ...new Set([...REDWALL_LABELS.join(\"\"), ...REDWALL_VALUES]),\n]\n  .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)\n  .join(\"\");",
    'import { codepointAt } from "./typeset.ts";\nconst _labelsJoined = REDWALL_LABELS.join("");\nconst _set = new Set<string>();\nfor (const c of _labelsJoined) _set.add(c);\nfor (const c of REDWALL_VALUES) _set.add(c);\nconst _chars: string[] = [];\nfor (const c of _set) _chars.push(c);\nexport const REDWALL_CHARSET: string = _chars.sort((a, b) => codepointAt(a, 0) - codepointAt(b, 0)).join("");',
)
charset.write_text(charset_text)

print("applied scriptc tweaks")
PYEOF

mkdir -p "$(dirname "${OUTPUT}")"
cd "${BUILD_DIR}"
scriptc build src/main.ts -o "${OUTPUT}" --dynamic

echo "built ${OUTPUT}"
ls -lh "${OUTPUT}"