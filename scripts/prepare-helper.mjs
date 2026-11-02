// Builds the credential helper and copies it where Tauri's `externalBin` expects it:
//
//   src-tauri/binaries/perseus-credential-helper-<target-triple>[.exe]
//
// Tauri then ships it next to the main executable (the app looks for it there) and, in
// development, copies it beside the debug build. Run automatically by beforeDevCommand and
// beforeBuildCommand; run it by hand once before `cargo test` on a fresh checkout.
//
//   node scripts/prepare-helper.mjs [debug|release]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const profile = process.argv[2] === "release" ? "release" : "debug";
const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
if (!host) throw new Error("could not determine the Rust host target triple");
const exe = host.includes("windows") ? ".exe" : "";

const programs = ["perseus-credential-helper", "perseus-askpass"];
execFileSync(
  "cargo",
  ["build", ...(profile === "release" ? ["--release"] : []), ...programs.flatMap((p) => ["-p", p])],
  { stdio: "inherit" },
);

mkdirSync("src-tauri/binaries", { recursive: true });
for (const program of programs) {
  copyFileSync(
    join("target", profile, `${program}${exe}`),
    join("src-tauri", "binaries", `${program}-${host}${exe}`),
  );
  console.log(`prepared src-tauri/binaries/${program}-${host}${exe} (${profile})`);
}
