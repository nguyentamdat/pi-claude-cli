import process from "node:process";
import console from "node:console";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const ACCOUNT_NAMES = ["claude-1", "claude-2"];

export function accountFile(name) {
  if (!ACCOUNT_NAMES.includes(name)) throw new Error("Unknown Claude account.");
  return join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "claude-accounts",
    `${name}.json`,
  );
}

/** Never include parsed values or native parser/filesystem errors in failures. */
export function readAccountEnv(name) {
  const file = accountFile(name);
  const fail = (reason) => {
    throw new Error(`${name}: ${reason} (${file})`);
  };
  let raw;
  let stat;
  try {
    const fd = openSync(file, "r");
    try {
      stat = fstatSync(fd);
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      let dangling = false;
      try {
        dangling = lstatSync(file).isSymbolicLink();
      } catch {
        /* Truly absent. */
      }
      if (dangling) fail("account file symlink target missing");
      if (name === "claude-1")
        return { env: {}, source: "native default login" };
      fail("account file missing; configure this account before use");
    }
    fail("cannot read account file");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("invalid account JSON");
  }
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  if (
    !object(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !object(parsed.env)
  )
    fail('expected {"env":{...}}');
  const env = parsed.env;
  const keys = Object.keys(env);
  if (
    !keys.length ||
    keys.some(
      (key) => !["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"].includes(key),
    )
  )
    fail("env allows only CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_CONFIG_DIR");
  if (keys.some((key) => typeof env[key] !== "string" || !env[key].trim()))
    fail("account env values must be nonempty strings");
  if (env.CLAUDE_CODE_OAUTH_TOKEN && (stat.mode & 0o7777) !== 0o600)
    fail("token account file must have mode 0600 (chmod 600)");
  if (
    env.CLAUDE_CODE_OAUTH_TOKEN &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  )
    fail("token account file must be owned by the current user");
  if (env.CLAUDE_CONFIG_DIR) {
    try {
      if (
        !isAbsolute(env.CLAUDE_CONFIG_DIR) ||
        !statSync(env.CLAUDE_CONFIG_DIR).isDirectory()
      )
        throw new Error();
    } catch {
      fail("CLAUDE_CONFIG_DIR must be an absolute existing directory");
    }
  }
  const conflicts = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "ANTHROPIC_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  ].filter((key) => process.env[key]);
  if (conflicts.length)
    fail(
      `conflicting inherited authentication overrides: ${conflicts.join(", ")}; unset them before using a configured account`,
    );
  return { env: { ...env }, source: file };
}

export function accountStatus(name) {
  try {
    const { env, source } = readAccountEnv(name);
    let note = "";
    if (name === "claude-1" && !env.CLAUDE_CODE_OAUTH_TOKEN) {
      try {
        const settings = JSON.parse(
          readFileSync(
            join(
              env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
              "settings.json",
            ),
            "utf8",
          ),
        );
        if (settings?.env?.CLAUDE_CODE_OAUTH_TOKEN)
          note = "; claude-1 follows manual default token from settings.json";
      } catch {
        /* Status must not require a native settings file. */
      }
    }
    return `${name}: ${source}; token present: ${env.CLAUDE_CODE_OAUTH_TOKEN ? "yes" : "no"}; config dir: ${env.CLAUDE_CONFIG_DIR || "native default (CLAUDE_CONFIG_DIR unset)"}${note}`;
  } catch (error) {
    return error.message;
  }
}

// Wrappers capture this output in a shell variable, never in a file or log.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (process.argv[2] !== "--shell-env")
      throw new Error("Expected --shell-env <account>.");
    const { env } = readAccountEnv(process.argv[3]);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    console.log("unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR;");
    for (const [key, value] of Object.entries(env))
      console.log(`export ${key}=${quote(value)};`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
