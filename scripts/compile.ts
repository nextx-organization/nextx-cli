// Standalone binaries (no Node needed) for the install script and release assets. Run with Bun:
//   bun scripts/compile.ts <brand> <target> <outfile>      target: bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64 | bun-linux-arm64 | bun-windows-x64
// Tokens fall back to a 0600 file in these builds (the keychain addon is native per platform); npm/brew installs use the keychain.
import pkg from "../package.json" with { type: "json" };

const [brand = "nextx", target = "bun", outfile = `dist-bin/${brand}`] = process.argv.slice(2);

const stub = {
  name: "stub-optional",
  setup(build: { onResolve: Function; onLoad: Function }) {
    // Ink loads React devtools only when DEV=true; the keychain addon is optional at runtime.
    build.onResolve({ filter: /^(react-devtools-core|@napi-rs\/keyring)$/ }, (a: { path: string }) => ({ path: a.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (a: { path: string }) => ({
      contents: a.path === "@napi-rs/keyring" ? "throw new Error('keychain addon not bundled');" : "export default { connectToDevTools() {} };",
      loader: "js",
    }));
  },
};

const result = await Bun.build({
  entrypoints: [`src/bin/${brand}.ts`],
  compile: { target, outfile },
  minify: true,
  define: { __CLI_VERSION__: JSON.stringify(pkg.version), "process.env.DEV": '"false"' },
  plugins: [stub],
} as never);
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile} (${target})`);
