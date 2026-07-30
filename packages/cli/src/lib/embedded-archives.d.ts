/**
 * Ambient module declaration for Bun's compiled-binary file-asset embedding
 * (`import x from './f.tar.gz' with { type: 'file' }`). Bun resolves this to
 * a string path at both dev-run and compiled-binary runtime (a `/$bunfs/...`
 * virtual path inside `--compile` binaries) — see embedded-assets.ts.
 */
declare module '*.tar.gz' {
  const path: string;
  export default path;
}
