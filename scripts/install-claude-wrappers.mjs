#!/usr/bin/env node
import process from "node:process";
import console from "node:console";
import {
  chmodSync,
  accessSync,
  constants,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const args = process.argv.slice(2);
let binDir = join(homedir(), ".local", "bin");
let dryRun = false;
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--bin-dir" && args[i + 1])
      binDir = resolve(args[++i]);
    else
      throw new Error(
        "Usage: install-claude-wrappers.mjs [--dry-run] [--bin-dir <directory>]",
      );
  }
  let claude;
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    try {
      const candidate = realpathSync(resolve(dir, "claude"));
      accessSync(candidate, constants.X_OK);
      if (
        statSync(candidate).isFile() &&
        !/^claude-[12]$/.test(basename(candidate))
      ) {
        claude = candidate;
        break;
      }
    } catch {
      /* Try the next PATH entry. */
    }
  }
  if (!claude)
    throw new Error(
      "Cannot resolve a real executable claude on PATH (wrappers cannot target themselves).",
    );
  const reader = fileURLToPath(
    new URL("../src/claude-account-env.mjs", import.meta.url),
  );
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  if (!dryRun) mkdirSync(binDir, { recursive: true });
  for (const name of ["claude-1", "claude-2"]) {
    const target = join(binDir, name);
    const script = `#!/bin/sh\n# pi-claude-cli account wrapper; credentials are read only at runtime.\naccount_env=$(${quote(process.execPath)} ${quote(reader)} --shell-env ${quote(name)}) || exit $?\neval "$account_env"\nunset account_env\nexec ${quote(claude)} "$@"\n`;
    if (!dryRun) {
      // Do not follow a preexisting symlink or overwrite an unrelated executable.
      writeFileSync(target, script, { mode: 0o755, flag: "wx" });
      chmodSync(target, 0o755);
    }
    console.log(
      `${dryRun ? "Would write" : "Wrote"} ${target} (0755), claude: ${claude}`,
    );
  }
} catch (error) {
  console.error(
    error.code === "EEXIST"
      ? "Wrapper target exists; remove it explicitly before reinstalling."
      : "code" in error
        ? "Cannot install Claude wrappers; check PATH and bin directory permissions."
        : error.message,
  );
  process.exitCode = 1;
}
