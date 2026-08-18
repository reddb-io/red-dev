/**
 * Bun resolves `import x from "./f.sh" with { type: "text" }` to the
 * file's contents at build time, and inlines it into a compiled binary.
 * TypeScript has no idea that is a thing, so declare the shape.
 */
declare module "*.sh" {
  const content: string;
  export default content;
}

declare module "*.conf" {
  const content: string;
  export default content;
}

declare module "*.kdl" {
  const content: string;
  export default content;
}

/**
 * `with { type: "file" }`, which is a different thing to the three above.
 *
 * The text form decodes UTF-8 and hands back the contents; a PNG put
 * through it comes out corrupted. The file form hands back a *path* —
 * a real one under `bun run`, one into the executable's embedded blobs
 * under `--compile` — and `Bun.file()` reads either without caring.
 *
 * So the declared type is the path, not the bytes. Getting this wrong
 * type-checks either way, which is why the smoke test asserts the PNG
 * signature rather than trusting it.
 */
declare module "*.png" {
  const path: string;
  export default path;
}

/**
 * Same mechanism, for the vendored font subset. A TTF put through the
 * text form comes back as mangled UTF-8 with a plausible length, exactly
 * as a PNG does.
 */
declare module "*.ttf" {
  const path: string;
  export default path;
}

/**
 * Same mechanism, for the vendored Sigstore trust root. It is JSON on
 * disk, but it is handed to cosign as a *file*, so what the importer
 * needs is a path to write out, not the parsed object — and a `.json`
 * specifier types as the object whatever the import attribute says,
 * which is why the vendored copy carries this extension instead.
 */
declare module "*.embedded" {
  const path: string;
  export default path;
}
