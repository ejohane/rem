import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const semverPattern = /^\d+\.\d+\.\d+$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const githubApiBaseUrl = "https://api.github.com";

export type ReleaseArch = "arm64" | "x64";
export type UpdatePlatform = "darwin" | "linux" | "win32";
type ReleasePlatformLabel = "macos" | "linux" | "windows";
type ArchiveFormat = "tar.gz" | "zip";
type InstallerKind = "bash" | "powershell";

export interface ReleaseAsset {
  name: string;
  url: string;
}

interface ReleaseTarget {
  platform: UpdatePlatform;
  platformLabel: ReleasePlatformLabel;
  arch: ReleaseArch;
  archiveFormat: ArchiveFormat;
  installerFile: string;
  installerKind: InstallerKind;
}

interface GithubReleaseRecord {
  tag: string;
  version: string;
  assets: ReleaseAsset[];
}

interface ReleaseAssetPair {
  archive: ReleaseAsset;
  checksum: ReleaseAsset;
}

export class UpdateCommandError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "UpdateCommandError";
  }
}

export interface RemSelfUpdateInput {
  repo: string;
  version?: string;
  arch?: string;
  installDir?: string;
  binDir?: string;
  local?: boolean;
  check?: boolean;
  force?: boolean;
  platform?: NodeJS.Platform;
  processArch?: string;
  currentVersion?: string | null;
  githubToken?: string;
}

export interface RemSelfUpdateResult {
  outcome: "up_to_date" | "available" | "installed";
  repo: string;
  tag: string;
  platform: UpdatePlatform;
  currentVersion: string | null;
  targetVersion: string;
  arch: ReleaseArch;
  archiveName: string;
  checkOnly: boolean;
  installed: boolean;
  forced: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSemverInput(raw: string, context: string): string {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  if (!semverPattern.test(withoutPrefix)) {
    throw new UpdateCommandError(
      "update_invalid_version",
      `${context} must be semantic (MAJOR.MINOR.PATCH), got: ${raw}`,
    );
  }

  return withoutPrefix;
}

export function extractVersionFromTag(tag: string): string {
  return normalizeSemverInput(tag, "Release tag");
}

function resolveReleaseArch(processArch: string, archOverride?: string): ReleaseArch {
  if (archOverride) {
    const normalized = archOverride.trim();
    if (normalized === "arm64" || normalized === "x64") {
      return normalized;
    }
    throw new UpdateCommandError(
      "update_invalid_arch",
      `Invalid --arch value: ${archOverride}. Expected: arm64|x64`,
    );
  }

  if (processArch === "arm64" || processArch === "aarch64") {
    return "arm64";
  }
  if (processArch === "x64" || processArch === "x86_64" || processArch === "amd64") {
    return "x64";
  }

  throw new UpdateCommandError(
    "update_unsupported_arch",
    `Unsupported architecture for update artifacts: ${processArch}`,
  );
}

function normalizePlatform(platform: string): UpdatePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }

  throw new UpdateCommandError(
    "update_unsupported_platform",
    `rem update supports darwin, linux, and win32 (detected: ${platform}).`,
  );
}

export function resolveReleaseTarget(
  platform: string,
  processArch: string,
  archOverride?: string,
): ReleaseTarget {
  const normalizedPlatform = normalizePlatform(platform);
  const arch = resolveReleaseArch(processArch, archOverride);

  if (normalizedPlatform === "darwin") {
    return {
      platform: normalizedPlatform,
      platformLabel: "macos",
      arch,
      archiveFormat: "tar.gz",
      installerFile: "install.sh",
      installerKind: "bash",
    };
  }

  if (normalizedPlatform === "linux") {
    return {
      platform: normalizedPlatform,
      platformLabel: "linux",
      arch,
      archiveFormat: "tar.gz",
      installerFile: "install.sh",
      installerKind: "bash",
    };
  }

  return {
    platform: normalizedPlatform,
    platformLabel: "windows",
    arch,
    archiveFormat: "zip",
    installerFile: "install.ps1",
    installerKind: "powershell",
  };
}

export function extractSha256Digest(content: string): string {
  const match = content.match(/\b([a-fA-F0-9]{64})\b/);
  if (!match) {
    throw new UpdateCommandError(
      "update_invalid_checksum",
      "Checksum file does not contain a valid SHA-256 digest.",
    );
  }

  return match[1].toLowerCase();
}

export function resolveReleaseAssets(
  assets: ReleaseAsset[],
  version: string,
  target: ReleaseTarget,
): ReleaseAssetPair {
  const archiveName = `rem-${version}-${target.platformLabel}-${target.arch}.${target.archiveFormat}`;
  const checksumName = `${archiveName}.sha256`;
  const archive = assets.find((asset) => asset.name === archiveName);
  const checksum = assets.find((asset) => asset.name === checksumName);

  if (!archive || !checksum) {
    throw new UpdateCommandError(
      "update_asset_not_found",
      `Release assets missing for ${archiveName} and/or ${checksumName}.`,
    );
  }

  return {
    archive,
    checksum,
  };
}

export async function resolveCurrentVersionHint(input?: {
  env?: Record<string, string | undefined>;
  execPath?: string;
  cwd?: string;
}): Promise<string | null> {
  const env = input?.env ?? process.env;
  const execPath = input?.execPath ?? process.execPath;
  const cwd = input?.cwd ?? process.cwd();

  const fromEnv = env.REM_VERSION?.trim();
  if (fromEnv) {
    try {
      return normalizeSemverInput(fromEnv, "Installed version");
    } catch {
      // Ignore invalid env override and continue probing.
    }
  }

  const versionFiles: string[] = [];
  const executableName = path.basename(execPath).toLowerCase();
  if (executableName === "rem" || executableName === "rem.exe") {
    versionFiles.push(path.join(path.dirname(execPath), "VERSION"));
  }
  versionFiles.push(path.join(cwd, "VERSION"));
  for (const versionPath of versionFiles) {
    const file = Bun.file(versionPath);
    if (!(await file.exists())) {
      continue;
    }

    const content = (await file.text()).trim();
    if (!content) {
      continue;
    }

    try {
      return normalizeSemverInput(content, "Installed version");
    } catch {
      // Keep probing if the file content is malformed.
    }
  }

  let scanDir = cwd;
  while (true) {
    const packageJsonPath = path.join(scanDir, "package.json");
    const packageFile = Bun.file(packageJsonPath);
    if (await packageFile.exists()) {
      try {
        const payload = JSON.parse(await packageFile.text()) as {
          name?: unknown;
          version?: unknown;
        };
        if (payload.name === "rem" && typeof payload.version === "string") {
          return normalizeSemverInput(payload.version, "package.json version");
        }
      } catch {
        // Continue scanning parent directories when parse fails.
      }
    }

    const parentDir = path.dirname(scanDir);
    if (parentDir === scanDir) {
      break;
    }
    scanDir = parentDir;
  }

  return null;
}

function encodeRepoSlug(repo: string): string {
  const parts = repo.split("/");
  return `${encodeURIComponent(parts[0] ?? "")}/${encodeURIComponent(parts[1] ?? "")}`;
}

function buildGithubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "rem-cli-update",
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function parseGithubReleasePayload(payload: unknown): GithubReleaseRecord {
  if (!isPlainObject(payload)) {
    throw new UpdateCommandError("update_release_parse_failed", "Invalid GitHub release payload.");
  }

  const tagName = payload.tag_name;
  const rawAssets = payload.assets;
  if (typeof tagName !== "string" || !Array.isArray(rawAssets)) {
    throw new UpdateCommandError("update_release_parse_failed", "Invalid GitHub release payload.");
  }

  const assets: ReleaseAsset[] = [];
  for (const entry of rawAssets) {
    if (!isPlainObject(entry)) {
      continue;
    }
    if (typeof entry.name !== "string" || typeof entry.browser_download_url !== "string") {
      continue;
    }
    assets.push({
      name: entry.name,
      url: entry.browser_download_url,
    });
  }

  if (assets.length === 0) {
    throw new UpdateCommandError(
      "update_release_parse_failed",
      "GitHub release payload did not include downloadable assets.",
    );
  }

  const version = extractVersionFromTag(tagName);
  return {
    tag: tagName,
    version,
    assets,
  };
}

async function fetchGithubRelease(
  repo: string,
  requestedVersion: string | undefined,
  token: string | undefined,
): Promise<GithubReleaseRecord> {
  if (!repoPattern.test(repo)) {
    throw new UpdateCommandError(
      "update_invalid_repo",
      `Invalid --repo value: ${repo}. Expected owner/repo.`,
    );
  }

  const encodedRepo = encodeRepoSlug(repo);
  const endpoint = requestedVersion
    ? `${githubApiBaseUrl}/repos/${encodedRepo}/releases/tags/v${requestedVersion}`
    : `${githubApiBaseUrl}/repos/${encodedRepo}/releases/latest`;

  const response = await fetch(endpoint, {
    headers: buildGithubHeaders(token),
  });
  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = (await response.text()).trim();
    } catch {
      // Ignore parse failures for error response body.
    }

    const details = bodyText ? ` ${bodyText}` : "";
    throw new UpdateCommandError(
      "update_release_fetch_failed",
      `Failed to fetch GitHub release metadata (${response.status} ${response.statusText}).${details}`,
    );
  }

  const payload = parseGithubReleasePayload(await response.json());
  if (requestedVersion && payload.version !== requestedVersion) {
    throw new UpdateCommandError(
      "update_release_mismatch",
      `Requested version ${requestedVersion} resolved to tag ${payload.tag}.`,
    );
  }

  return payload;
}

async function downloadAsset(url: string, destinationPath: string, token?: string): Promise<void> {
  const response = await fetch(url, {
    headers: buildGithubHeaders(token),
  });
  if (!response.ok) {
    throw new UpdateCommandError(
      "update_download_failed",
      `Failed to download asset (${response.status} ${response.statusText}): ${url}`,
    );
  }

  const bytes = await response.arrayBuffer();
  await Bun.write(destinationPath, bytes);
}

async function computeFileSha256(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function trimOutput(output: Uint8Array | undefined | null): string {
  return Buffer.from(output ?? new Uint8Array())
    .toString("utf8")
    .trim();
}

function buildTarExtractInvocation(archivePath: string): string[] {
  return ["tar", "-xzf", archivePath];
}

function toPowershellSingleQuotedLiteral(input: string): string {
  return `'${input.replace(/'/g, "''")}'`;
}

function buildZipExtractInvocation(archivePath: string, outputDir: string): string[] {
  const command = `Expand-Archive -LiteralPath ${toPowershellSingleQuotedLiteral(archivePath)} -DestinationPath ${toPowershellSingleQuotedLiteral(outputDir)} -Force`;
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ];
}

async function extractArchive(
  archivePath: string,
  outputDir: string,
  archiveFormat: ArchiveFormat,
): Promise<void> {
  const invocation =
    archiveFormat === "tar.gz"
      ? buildTarExtractInvocation(archivePath)
      : buildZipExtractInvocation(archivePath, outputDir);

  const extractResult = Bun.spawnSync(invocation, {
    cwd: outputDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (extractResult.exitCode === 0) {
    return;
  }

  const stderr = trimOutput(extractResult.stderr);
  const stdout = trimOutput(extractResult.stdout);
  const details = stderr || stdout || "tar extraction failed";
  throw new UpdateCommandError("update_extract_failed", details);
}

function buildInstallerArgs(
  installerKind: InstallerKind,
  options: {
    local?: boolean;
    installDir?: string;
    binDir?: string;
  },
): string[] {
  if (options.local && (options.installDir || options.binDir)) {
    throw new UpdateCommandError(
      "update_invalid_options",
      "--local cannot be combined with --install-dir or --bin-dir.",
    );
  }

  if (installerKind === "powershell") {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "./install.ps1",
    ];
    if (options.installDir) {
      args.push("-InstallDir", options.installDir);
    }
    if (options.binDir) {
      args.push("-BinDir", options.binDir);
    }
    if (options.local) {
      args.push("-Local");
    }
    return args;
  }

  const args = ["./install.sh"];
  if (options.installDir) {
    args.push("--install-dir", options.installDir);
  }
  if (options.binDir) {
    args.push("--bin-dir", options.binDir);
  }
  if (options.local) {
    args.push("--local");
  }

  return args;
}

async function runInstaller(
  packageDir: string,
  installerKind: InstallerKind,
  args: string[],
): Promise<void> {
  const installInvocation =
    installerKind === "powershell" ? ["powershell", ...args] : ["bash", ...args];
  const installResult = Bun.spawnSync(installInvocation, {
    cwd: packageDir,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });

  if (installResult.exitCode === 0) {
    return;
  }

  const stderr = trimOutput(installResult.stderr);
  const stdout = trimOutput(installResult.stdout);
  let message = stderr || stdout || `Installer exited with code ${installResult.exitCode}`;
  if (installerKind === "bash" && /permission denied|operation not permitted/i.test(message)) {
    message = `${message}\nTry running with elevated permissions or use --local.`;
  }
  if (
    installerKind === "powershell" &&
    /access to the path|permission denied|unauthorizedaccess/i.test(message)
  ) {
    message = `${message}\nTry running PowerShell as Administrator or use --local.`;
  }
  throw new UpdateCommandError("update_install_failed", message);
}

function resolvePackageDirFromArchiveName(
  tempRoot: string,
  archiveName: string,
  archiveFormat: ArchiveFormat,
): string {
  const packageName =
    archiveFormat === "zip"
      ? archiveName.replace(/\.zip$/, "")
      : archiveName.replace(/\.tar\.gz$/, "");
  return path.join(tempRoot, packageName);
}

export async function runRemSelfUpdate(input: RemSelfUpdateInput): Promise<RemSelfUpdateResult> {
  const runtimePlatform = input.platform ?? process.platform;

  const repo = input.repo.trim();
  const requestedVersion = input.version
    ? normalizeSemverInput(input.version, "Target version")
    : undefined;
  const target = resolveReleaseTarget(
    runtimePlatform,
    input.processArch ?? process.arch,
    input.arch,
  );
  const currentVersion =
    input.currentVersion === undefined ? await resolveCurrentVersionHint() : input.currentVersion;
  const release = await fetchGithubRelease(repo, requestedVersion, input.githubToken);
  const assets = resolveReleaseAssets(release.assets, release.version, target);
  const checkOnly = Boolean(input.check);
  const forceInstall = Boolean(input.force);

  const upToDate = currentVersion !== null && currentVersion === release.version;
  if (upToDate && !forceInstall) {
    return {
      outcome: "up_to_date",
      repo,
      tag: release.tag,
      platform: target.platform,
      currentVersion,
      targetVersion: release.version,
      arch: target.arch,
      archiveName: assets.archive.name,
      checkOnly,
      installed: false,
      forced: forceInstall,
    };
  }

  if (checkOnly) {
    return {
      outcome: "available",
      repo,
      tag: release.tag,
      platform: target.platform,
      currentVersion,
      targetVersion: release.version,
      arch: target.arch,
      archiveName: assets.archive.name,
      checkOnly: true,
      installed: false,
      forced: forceInstall,
    };
  }

  const installerArgs = buildInstallerArgs(target.installerKind, {
    local: input.local,
    installDir: input.installDir,
    binDir: input.binDir,
  });

  let tempRoot: string | null = null;
  try {
    tempRoot = await mkdtemp(path.join(tmpdir(), "rem-update-"));
    const archivePath = path.join(tempRoot, assets.archive.name);
    const checksumPath = path.join(tempRoot, assets.checksum.name);

    await downloadAsset(assets.archive.url, archivePath, input.githubToken);
    await downloadAsset(assets.checksum.url, checksumPath, input.githubToken);

    const expectedSha = extractSha256Digest(await Bun.file(checksumPath).text());
    const actualSha = await computeFileSha256(archivePath);
    if (expectedSha !== actualSha) {
      throw new UpdateCommandError(
        "update_checksum_mismatch",
        `Checksum mismatch for ${assets.archive.name}.`,
      );
    }

    await extractArchive(archivePath, tempRoot, target.archiveFormat);

    const packageDir = resolvePackageDirFromArchiveName(
      tempRoot,
      assets.archive.name,
      target.archiveFormat,
    );
    const installerPath = path.join(packageDir, target.installerFile);
    if (!(await Bun.file(installerPath).exists())) {
      throw new UpdateCommandError(
        "update_installer_missing",
        `Expected installer not found in package: ${installerPath}`,
      );
    }

    await runInstaller(packageDir, target.installerKind, installerArgs);
  } finally {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  return {
    outcome: "installed",
    repo,
    tag: release.tag,
    platform: target.platform,
    currentVersion,
    targetVersion: release.version,
    arch: target.arch,
    archiveName: assets.archive.name,
    checkOnly: false,
    installed: true,
    forced: forceInstall,
  };
}
