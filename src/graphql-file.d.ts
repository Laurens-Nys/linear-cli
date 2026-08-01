// Bun resolves `import p from "./x.graphql" with { type: "file" }` to a path string,
// and embeds the file when compiling with `bun build --compile`.
declare module "*.graphql" {
  const path: string;
  export default path;
}
