import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type RemReleaseLookupResult,
  UpdateCommandError,
  extractSha256Digest,
  extractVersionFromTag,
  normalizeSemverInput,
  resolveCurrentVersionHint,
  resolveReleaseAssets,
  resolveReleaseTarget,
  runRemSelfUpdate,
  runRemSelfUpdateWithInternals,
} from "./update";

function releaseFixture(input: {
  version: string;
  platform: "macos" | "linux" | "windows";
  arch: "arm64" | "x64";
  archiveFormat: "tar.gz" | "zip";
}): RemReleaseLookupResult {
  const archiveName = `rem-${input.version}-${input.platform}-${input.arch}.${input.archiveFormat}`;
  return {
    tag: `v${input.version}`,
    version: input.version,
    assets: [
      {
        name: archiveName,
        url: `https://example.com/${archiveName}`,
      },
      {
        name: `${archiveName}.sha256`,
        url: `https://example.com/${archiveName}.sha256`,
      },
    ],
  };
}

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

  test("fetches latest release metadata via GitHub API by default", async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ input: String(input), init });
      return new Response(
        JSON.stringify({
          tag_name: "v1.2.3",
          assets: [
            {
              name: "rem-1.2.3-linux-x64.tar.gz",
              browser_download_url: "https://example.com/rem-1.2.3-linux-x64.tar.gz",
            },
            {
              name: "rem-1.2.3-linux-x64.tar.gz.sha256",
              browser_download_url: "https://example.com/rem-1.2.3-linux-x64.tar.gz.sha256",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await runRemSelfUpdateWithInternals({
        repo: "ejohane/rem",
        platform: "linux",
        processArch: "x64",
        currentVersion: "1.2.2",
        check: true,
        githubToken: "gh-token",
      });

      expect(result.outcome).toBe("available");
      expect(fetchCalls[0]?.input).toBe("https://api.github.com/repos/ejohane/rem/releases/latest");
      expect(fetchCalls[0]?.init?.headers).toEqual({
        accept: "application/vnd.github+json",
        authorization: "Bearer gh-token",
        "user-agent": "rem-cli-update",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns invalid repo when default release fetch receives malformed repo slug", async () => {
    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals({
        repo: "invalid-repo",
        platform: "linux",
        processArch: "x64",
        currentVersion: "1.0.0",
        check: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_invalid_repo");
  });

  test("returns parse failure when GitHub payload shape is invalid", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ tag_name: "v1.2.3", assets: "invalid" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals({
        repo: "ejohane/rem",
        platform: "linux",
        processArch: "x64",
        currentVersion: "1.0.0",
        check: true,
      });
    } catch (error) {
      thrown = error;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_release_parse_failed");
  });

  test("returns parse failure when release payload has no downloadable assets", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          tag_name: "v1.2.3",
          assets: [{ id: 1 }],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals({
        repo: "ejohane/rem",
        platform: "linux",
        processArch: "x64",
        currentVersion: "1.0.0",
        check: true,
      });
    } catch (error) {
      thrown = error;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_release_parse_failed");
  });

  test("returns fetch failure details from GitHub release metadata request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response("resource not found", {
        status: 404,
        statusText: "Not Found",
      });
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals({
        repo: "ejohane/rem",
        platform: "linux",
        processArch: "x64",
        currentVersion: "1.0.0",
        check: true,
      });
    } catch (error) {
      thrown = error;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_release_fetch_failed");
    expect((thrown as UpdateCommandError).message).toContain("resource not found");
  });

  test("returns release mismatch when requested version resolves to different tag", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          tag_name: "v1.2.4",
          assets: [
            {
              name: "rem-1.2.4-linux-x64.tar.gz",
              browser_download_url: "https://example.com/rem-1.2.4-linux-x64.tar.gz",
            },
            {
              name: "rem-1.2.4-linux-x64.tar.gz.sha256",
              browser_download_url: "https://example.com/rem-1.2.4-linux-x64.tar.gz.sha256",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals({
        repo: "ejohane/rem",
        version: "1.2.3",
        platform: "linux",
        processArch: "x64",
        currentVersion: "1.0.0",
        check: true,
      });
    } catch (error) {
      thrown = error;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_release_mismatch");
  });

  test("runRemSelfUpdate delegates to the update pipeline", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          tag_name: "v1.3.0",
          assets: [
            {
              name: "rem-1.3.0-linux-x64.tar.gz",
              browser_download_url: "https://example.com/rem-1.3.0-linux-x64.tar.gz",
            },
            {
              name: "rem-1.3.0-linux-x64.tar.gz.sha256",
              browser_download_url: "https://example.com/rem-1.3.0-linux-x64.tar.gz.sha256",
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    }) as unknown as typeof fetch;

    try {
      const result = await runRemSelfUpdate({
        repo: "ejohane/rem",
        platform: "linux",
        processArch: "x64",
        currentVersion: "1.2.0",
        check: true,
      });

      expect(result.outcome).toBe("available");
      expect(result.targetVersion).toBe("1.3.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns up_to_date when current and target versions match", async () => {
    const release = releaseFixture({
      version: "0.2.0",
      platform: "linux",
      arch: "x64",
      archiveFormat: "tar.gz",
    });

    const result = await runRemSelfUpdateWithInternals(
      {
        repo: "ejohane/rem",
        platform: "linux",
        processArch: "x64",
        currentVersion: "0.2.0",
      },
      {
        fetchGithubRelease: async () => release,
      },
    );

    expect(result.outcome).toBe("up_to_date");
    expect(result.installed).toBeFalse();
    expect(result.platform).toBe("linux");
    expect(result.archiveName).toBe("rem-0.2.0-linux-x64.tar.gz");
  });

  test("returns available for check-only update requests", async () => {
    const release = releaseFixture({
      version: "0.3.0",
      platform: "macos",
      arch: "arm64",
      archiveFormat: "tar.gz",
    });

    const result = await runRemSelfUpdateWithInternals(
      {
        repo: "ejohane/rem",
        platform: "darwin",
        processArch: "arm64",
        currentVersion: "0.2.0",
        check: true,
      },
      {
        fetchGithubRelease: async () => release,
      },
    );

    expect(result.outcome).toBe("available");
    expect(result.checkOnly).toBeTrue();
    expect(result.installed).toBeFalse();
    expect(result.targetVersion).toBe("0.3.0");
  });

  test("installs update and runs all install pipeline steps", async () => {
    const release = releaseFixture({
      version: "0.4.0",
      platform: "windows",
      arch: "x64",
      archiveFormat: "zip",
    });
    const digest = "b".repeat(64);
    const calls = {
      downloads: [] as string[],
      extracts: [] as Array<{ archivePath: string; archiveFormat: "tar.gz" | "zip" }>,
      installers: [] as Array<{ packageDir: string; args: string[] }>,
      cleaned: [] as string[],
    };

    const result = await runRemSelfUpdateWithInternals(
      {
        repo: "ejohane/rem",
        platform: "win32",
        processArch: "x64",
        currentVersion: "0.3.0",
        local: true,
      },
      {
        fetchGithubRelease: async () => release,
        makeTempDir: async () => "/tmp/rem-update-test",
        downloadAsset: async (url) => {
          calls.downloads.push(url);
        },
        readTextFile: async () => `${digest}  rem-0.4.0-windows-x64.zip`,
        computeFileSha256: async () => digest,
        extractArchive: async (archivePath, _outputDir, archiveFormat) => {
          calls.extracts.push({ archivePath, archiveFormat });
        },
        installerExists: async () => true,
        runInstaller: async (packageDir, args) => {
          calls.installers.push({ packageDir, args });
        },
        cleanupTempDir: async (tempRoot) => {
          calls.cleaned.push(tempRoot);
        },
      },
    );

    expect(result.outcome).toBe("installed");
    expect(result.platform).toBe("win32");
    expect(result.installed).toBeTrue();
    expect(calls.downloads.length).toBe(2);
    expect(calls.extracts[0]?.archiveFormat).toBe("zip");
    expect(calls.installers[0]?.args).toContain("-Local");
    expect(calls.cleaned).toEqual(["/tmp/rem-update-test"]);
  });

  test("supports forced reinstall even when current version matches", async () => {
    const release = releaseFixture({
      version: "0.5.0",
      platform: "linux",
      arch: "x64",
      archiveFormat: "tar.gz",
    });
    let installCalled = false;

    const result = await runRemSelfUpdateWithInternals(
      {
        repo: "ejohane/rem",
        platform: "linux",
        processArch: "x64",
        currentVersion: "0.5.0",
        force: true,
      },
      {
        fetchGithubRelease: async () => release,
        makeTempDir: async () => "/tmp/rem-update-force",
        downloadAsset: async () => {},
        readTextFile: async () => `${"c".repeat(64)}  rem-0.5.0-linux-x64.tar.gz`,
        computeFileSha256: async () => "c".repeat(64),
        extractArchive: async () => {},
        installerExists: async () => true,
        runInstaller: async () => {
          installCalled = true;
        },
        cleanupTempDir: async () => {},
      },
    );

    expect(result.outcome).toBe("installed");
    expect(result.forced).toBeTrue();
    expect(installCalled).toBeTrue();
  });

  test("returns checksum mismatch error and still cleans temp directory", async () => {
    const release = releaseFixture({
      version: "0.6.0",
      platform: "linux",
      arch: "x64",
      archiveFormat: "tar.gz",
    });
    const cleaned: string[] = [];

    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals(
        {
          repo: "ejohane/rem",
          platform: "linux",
          processArch: "x64",
          currentVersion: "0.5.0",
        },
        {
          fetchGithubRelease: async () => release,
          makeTempDir: async () => "/tmp/rem-update-checksum",
          downloadAsset: async () => {},
          readTextFile: async () => `${"d".repeat(64)}  rem-0.6.0-linux-x64.tar.gz`,
          computeFileSha256: async () => "e".repeat(64),
          cleanupTempDir: async (tempRoot) => {
            cleaned.push(tempRoot);
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_checksum_mismatch");
    expect(cleaned).toEqual(["/tmp/rem-update-checksum"]);
  });

  test("returns installer missing when extracted package lacks installer", async () => {
    const release = releaseFixture({
      version: "0.7.0",
      platform: "windows",
      arch: "x64",
      archiveFormat: "zip",
    });
    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals(
        {
          repo: "ejohane/rem",
          platform: "win32",
          processArch: "x64",
          currentVersion: "0.6.0",
        },
        {
          fetchGithubRelease: async () => release,
          makeTempDir: async () => "/tmp/rem-update-installer-missing",
          downloadAsset: async () => {},
          readTextFile: async () => `${"f".repeat(64)}  rem-0.7.0-windows-x64.zip`,
          computeFileSha256: async () => "f".repeat(64),
          extractArchive: async () => {},
          installerExists: async () => false,
          cleanupTempDir: async () => {},
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_installer_missing");
  });

  test("returns install failure when installer execution fails", async () => {
    const release = releaseFixture({
      version: "0.8.0",
      platform: "linux",
      arch: "x64",
      archiveFormat: "tar.gz",
    });
    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals(
        {
          repo: "ejohane/rem",
          platform: "linux",
          processArch: "x64",
          currentVersion: "0.7.0",
        },
        {
          fetchGithubRelease: async () => release,
          makeTempDir: async () => "/tmp/rem-update-install-fail",
          downloadAsset: async () => {},
          readTextFile: async () => `${"a".repeat(64)}  rem-0.8.0-linux-x64.tar.gz`,
          computeFileSha256: async () => "a".repeat(64),
          extractArchive: async () => {},
          installerExists: async () => true,
          runInstaller: async () => {
            throw new UpdateCommandError("update_install_failed", "installer failure");
          },
          cleanupTempDir: async () => {},
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_install_failed");
  });

  test("returns release fetch errors from the release lookup step", async () => {
    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals(
        {
          repo: "ejohane/rem",
          platform: "linux",
          processArch: "x64",
          currentVersion: "0.1.0",
        },
        {
          fetchGithubRelease: async () => {
            throw new UpdateCommandError("update_release_fetch_failed", "fetch failed");
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_release_fetch_failed");
  });

  test("returns invalid options when local is combined with install-dir", async () => {
    const release = releaseFixture({
      version: "0.9.0",
      platform: "linux",
      arch: "x64",
      archiveFormat: "tar.gz",
    });
    let thrown: unknown;
    try {
      await runRemSelfUpdateWithInternals(
        {
          repo: "ejohane/rem",
          platform: "linux",
          processArch: "x64",
          currentVersion: "0.8.0",
          local: true,
          installDir: "/tmp/rem",
        },
        {
          fetchGithubRelease: async () => release,
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpdateCommandError);
    expect((thrown as UpdateCommandError).code).toBe("update_invalid_options");
  });
});
