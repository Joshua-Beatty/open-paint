// Builds the WASM package with wasm-pack. Source paths that rustc embeds in panic messages are
// remapped, so the shipped .wasm names neither the builder's home folder nor the checkout.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const crateDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(crateDir, "..", "..");
const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");

const remaps = [
  [join(cargoHome, "registry", "src"), "/cargo/registry/src"],
  [join(cargoHome, "git", "checkouts"), "/cargo/git/checkouts"],
  [repoRoot, "/openpaint"],
];
const rustflags = remaps.flatMap(([from, to]) => ["--remap-path-prefix", `${from}=${to}`]);
const config = `target.wasm32-unknown-unknown.rustflags=${JSON.stringify(rustflags)}`;

const result = spawnSync(
  "wasm-pack",
  ["build", ".", "--target", "web", "--release", "--no-pack", "--", "--config", config],
  { cwd: crateDir, stdio: "inherit" },
);
if (result.error !== undefined) throw result.error;
process.exit(result.status ?? 1);
