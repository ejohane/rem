import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  UpdateCommandError,
  extractSha256Digest,
  extractVersionFromTag,
  normalizeSemverInput,
  resolveCurrentVersionHint,
  resolveReleaseAssets,
  resolveReleaseTarget,
} from "./update";

describe("update helpers", () => {
  test("normalizes semantic versions with or without leading v", () => {
    expect(normalizeSemverInput("1.2.3", "version")).toBe("1.2.3");
    expect(normalizeSemverInput("v1.2.3", "version")).toBe("1.2.3");
  });

  test("rejects invalid semantic versions", () => {
    let thrown: unknown;
    try {
      normalizeSemverInput("1.2", "version");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_invalid_version");
  });

  test("extracts semantic version from release tags", () => {
    expect(extractVersionFromTag("v0.1.0")).toBe("0.1.0");
  });

  test("maps process architecture to release target architecture", () => {
    expect(resolveReleaseTarget("darwin", "arm64").arch).toBe("arm64");
    expect(resolveReleaseTarget("linux", "x64").arch).toBe("x64");
    expect(resolveReleaseTarget("win32", "arm64", "x64").arch).toBe("x64");
  });

  test("rejects unsupported architectures", () => {
    let thrown: unknown;
    try {
      resolveReleaseTarget("darwin", "ia32");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_unsupported_arch");
  });

  test("extracts sha256 digest from checksum payload", () => {
    const digest = "a".repeat(64);
    expect(extractSha256Digest(`${digest}  rem-0.1.0-macos-arm64.tar.gz`)).toBe(digest);
  });

  test("resolves macOS release archive + checksum assets", () => {
    const assets = [
      {
        name: "rem-0.1.0-macos-arm64.tar.gz",
        url: "https://example.com/rem-0.1.0-macos-arm64.tar.gz",
      },
      {
        name: "rem-0.1.0-macos-arm64.tar.gz.sha256",
        url: "https://example.com/rem-0.1.0-macos-arm64.tar.gz.sha256",
      },
    ];
    const resolved = resolveReleaseAssets(assets, "0.1.0", resolveReleaseTarget("darwin", "arm64"));
    expect(resolved.archive.name).toBe("rem-0.1.0-macos-arm64.tar.gz");
    expect(resolved.checksum.name).toBe("rem-0.1.0-macos-arm64.tar.gz.sha256");
  });

  test("resolves linux release archive + checksum assets", () => {
    const assets = [
      {
        name: "rem-0.1.0-linux-x64.tar.gz",
        url: "https://example.com/rem-0.1.0-linux-x64.tar.gz",
      },
      {
        name: "rem-0.1.0-linux-x64.tar.gz.sha256",
        url: "https://example.com/rem-0.1.0-linux-x64.tar.gz.sha256",
      },
    ];
    const resolved = resolveReleaseAssets(assets, "0.1.0", resolveReleaseTarget("linux", "x64"));
    expect(resolved.archive.name).toBe("rem-0.1.0-linux-x64.tar.gz");
    expect(resolved.checksum.name).toBe("rem-0.1.0-linux-x64.tar.gz.sha256");
  });

  test("resolves windows release archive + checksum assets", () => {
    const assets = [
      {
        name: "rem-0.1.0-windows-x64.zip",
        url: "https://example.com/rem-0.1.0-windows-x64.zip",
      },
      {
        name: "rem-0.1.0-windows-x64.zip.sha256",
        url: "https://example.com/rem-0.1.0-windows-x64.zip.sha256",
      },
    ];
    const resolved = resolveReleaseAssets(assets, "0.1.0", resolveReleaseTarget("win32", "x64"));
    expect(resolved.archive.name).toBe("rem-0.1.0-windows-x64.zip");
    expect(resolved.checksum.name).toBe("rem-0.1.0-windows-x64.zip.sha256");
  });

  test("fails when required release assets are missing", () => {
    let thrown: unknown;
    try {
      resolveReleaseAssets([], "0.1.0", resolveReleaseTarget("darwin", "arm64"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_asset_not_found");
  });

  test("prefers root rem package version when executable is not rem", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rem-update-version-hint-"));
    const nestedCliDir = path.join(root, "apps", "cli");
    const fakeExecDir = path.join(root, "fake-bin");
    const fakeExecPath = path.join(fakeExecDir, "bun");

    try {
      await mkdir(nestedCliDir, { recursive: true });
      await mkdir(fakeExecDir, { recursive: true });
      await Bun.write(path.join(fakeExecDir, "VERSION"), "0.0.0\n");
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "rem", version: "0.9.1" }),
      );
      await writeFile(
        path.join(nestedCliDir, "package.json"),
        JSON.stringify({ name: "@rem-app/cli", version: "0.0.0" }),
      );

      const resolved = await resolveCurrentVersionHint({
        env: {},
        execPath: fakeExecPath,
        cwd: nestedCliDir,
      });
      expect(resolved).toBe("0.9.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses executable-adjacent VERSION when executable is rem", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rem-update-version-exec-"));
    const fakeExecDir = path.join(root, "bundle");
    const fakeExecPath = path.join(fakeExecDir, "rem");

    try {
      await mkdir(fakeExecDir, { recursive: true });
      await Bun.write(path.join(fakeExecDir, "VERSION"), "1.2.3\n");

      const resolved = await resolveCurrentVersionHint({
        env: {},
        execPath: fakeExecPath,
        cwd: root,
      });
      expect(resolved).toBe("1.2.3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsupported platforms", () => {
    let thrown: unknown;
    try {
      resolveReleaseTarget("freebsd", "x64");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_unsupported_platform");
  });
});
