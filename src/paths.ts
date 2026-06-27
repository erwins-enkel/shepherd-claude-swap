import path from "node:path";

/**
 * Filesystem-safe slug: NFC-normalize, then any char not in [A-Za-z0-9._-] → "_".
 * e.g. "plenz@topmedia.de" → "plenz_topmedia.de".
 */
export function slugifyEmail(email: string): string {
  return email.normalize("NFC").replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * cswap backup root.
 * Linux/WSL: $XDG_DATA_HOME/claude-swap (if XDG_DATA_HOME set & absolute) else
 *   ~/.local/share/claude-swap.
 * darwin/win: ~/.claude-swap-backup.
 * `env` defaults to process.env; `platform` defaults to process.platform — both
 * injectable for tests.
 */
export function cswapBackupRoot(opts?: {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  home?: string;
}): string {
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? env["HOME"] ?? "";

  if (platform === "linux") {
    const xdgDataHome = env["XDG_DATA_HOME"];
    if (xdgDataHome && path.isAbsolute(xdgDataHome)) {
      return path.join(xdgDataHome, "claude-swap");
    }
    return path.join(home, ".local", "share", "claude-swap");
  }

  // darwin, win32, etc.
  return path.join(home, ".claude-swap-backup");
}

/**
 * `<backupRoot>/sessions/<accountNumber>-<slugifyEmail(email)>`.
 */
export function sessionProfileDir(
  backupRoot: string,
  accountNumber: number,
  email: string,
): string {
  return path.join(backupRoot, "sessions", `${accountNumber}-${slugifyEmail(email)}`);
}
