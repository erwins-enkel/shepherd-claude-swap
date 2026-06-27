import { describe, expect, it } from "bun:test";
import { cswapBackupRoot, sessionProfileDir, slugifyEmail } from "../src/paths";

describe("slugifyEmail", () => {
  it("converts plenz@topmedia.de to plenz_topmedia.de", () => {
    expect(slugifyEmail("plenz@topmedia.de")).toBe("plenz_topmedia.de");
  });

  it("replaces @ with _ and keeps . and -", () => {
    expect(slugifyEmail("user@example.com")).toBe("user_example.com");
    expect(slugifyEmail("first.last@example.com")).toBe("first.last_example.com");
    expect(slugifyEmail("user-name@example.com")).toBe("user-name_example.com");
  });

  it("replaces non-[A-Za-z0-9._-] chars with _", () => {
    expect(slugifyEmail("user+tag@example.co.uk")).toBe("user_tag_example.co.uk");
    expect(slugifyEmail("user!name@example.com")).toBe("user_name_example.com");
  });

  it("NFC normalizes before replacing", () => {
    // NFD: e + combining acute → NFC: é (single code point)
    // Both should produce the same slug since NFC normalizes first
    const nfdEmail = "café@example.com"; // café in NFD
    const nfcEmail = "café@example.com"; // café in NFC
    expect(slugifyEmail(nfdEmail)).toBe(slugifyEmail(nfcEmail));
    // é is not in [A-Za-z0-9._-] so it becomes _
    expect(slugifyEmail(nfcEmail)).toBe("caf__example.com");
  });
});

describe("cswapBackupRoot", () => {
  it("linux default: ~/.local/share/claude-swap", () => {
    expect(cswapBackupRoot({ platform: "linux", home: "/home/user", env: {} })).toBe(
      "/home/user/.local/share/claude-swap",
    );
  });

  it("linux with absolute XDG_DATA_HOME: uses XDG path", () => {
    expect(
      cswapBackupRoot({
        platform: "linux",
        home: "/home/user",
        env: { XDG_DATA_HOME: "/custom/data" },
      }),
    ).toBe("/custom/data/claude-swap");
  });

  it("linux with non-absolute XDG_DATA_HOME: ignored, uses default", () => {
    expect(
      cswapBackupRoot({
        platform: "linux",
        home: "/home/user",
        env: { XDG_DATA_HOME: "relative/data" },
      }),
    ).toBe("/home/user/.local/share/claude-swap");
  });

  it("linux with empty XDG_DATA_HOME: ignored, uses default", () => {
    expect(
      cswapBackupRoot({
        platform: "linux",
        home: "/home/user",
        env: { XDG_DATA_HOME: "" },
      }),
    ).toBe("/home/user/.local/share/claude-swap");
  });

  it("darwin: ~/.claude-swap-backup", () => {
    expect(cswapBackupRoot({ platform: "darwin", home: "/Users/user", env: {} })).toBe(
      "/Users/user/.claude-swap-backup",
    );
  });

  it("win32: ~/.claude-swap-backup", () => {
    expect(cswapBackupRoot({ platform: "win32", home: "/home/user", env: {} })).toBe(
      "/home/user/.claude-swap-backup",
    );
  });
});

describe("sessionProfileDir", () => {
  it("composes <root>/sessions/<num>-<slugifiedEmail>", () => {
    const root = "/home/user/.local/share/claude-swap";
    expect(sessionProfileDir(root, 2, "plenz@topmedia.de")).toBe(
      "/home/user/.local/share/claude-swap/sessions/2-plenz_topmedia.de",
    );
  });

  it("uses the account number as-is", () => {
    const root = "/data/claude-swap";
    expect(sessionProfileDir(root, 1, "admin@example.com")).toBe(
      "/data/claude-swap/sessions/1-admin_example.com",
    );
  });
});
