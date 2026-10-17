import { fileURLToPath } from "node:url";
import { RUST_CRATES_SNAPSHOT, writeRustCratesSnapshot } from "./rust-crates.ts";

// Rewrites the checked-in list of the Rust crates in the WebAssembly kernels from Cargo
// (`pnpm --filter @openpaint/web licenses:rust`), for builds where Cargo cannot run.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const { crates } = writeRustCratesSnapshot(appDir);
console.log(`Wrote ${crates.length} crates to ${RUST_CRATES_SNAPSHOT}.`);
