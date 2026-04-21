import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: "es2022",
  external: [
    "@polkadot/api",
    "@polkadot/extension-dapp",
    "@polkadot/extension-inject",
    "@polkadot/keyring",
    "@polkadot/util",
    "@polkadot/util-crypto",
    "ethers",
  ],
});