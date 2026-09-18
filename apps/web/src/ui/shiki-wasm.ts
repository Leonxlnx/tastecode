/**
 * Stand-in for `shiki/wasm`, the 600 KB base64-inlined Oniguruma binary.
 * `@pierre/diffs` references it behind its optional `shiki-wasm` mode, which the
 * renderer CSP rules out; see `shiki-bundle.ts`.
 */
export default function loadOnigurumaWasm(): never {
  throw new Error('The Oniguruma WASM binary is not bundled; the renderer CSP forbids WebAssembly.')
}
