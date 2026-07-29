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
