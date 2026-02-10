#!/usr/bin/env bun
import path from "node:path";

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
};

const semverPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function parseSemver(version: string): ParsedSemver | null {
  const match = semverPattern.exec(version);
  if (!match) {
    return null;
  }

  return {
    major: Number.parseInt(match[1] ?? "", 10),
    minor: Number.parseInt(match[2] ?? "", 10),
    patch: Number.parseInt(match[3] ?? "", 10),
  };
}

function compareSemver(left: ParsedSemver, right: ParsedSemver): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }

  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }

  return left.patch - right.patch;
}

function formatSemver(version: ParsedSemver): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function bumpSemver(version: ParsedSemver, level: "major" | "minor" | "patch"): ParsedSemver {
  if (level === "major") {
    return {
      major: version.major + 1,
      minor: 0,
      patch: 0,
    };
  }

  if (level === "minor") {
    return {
      major: version.major,
      minor: version.minor + 1,
      patch: 0,
    };
  }

  return {
    major: version.major,
    minor: version.minor,
    patch: version.patch + 1,
  };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function readVersion(rootDir: string): Promise<string> {
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(await Bun.file(packageJsonPath).text()) as {
    version?: unknown;
  };

  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!version) {
    fail(`Missing version in ${packageJsonPath}`);
  }

  if (!parseSemver(version)) {
    fail(`Invalid semantic version '${version}' in ${packageJsonPath}; expected MAJOR.MINOR.PATCH`);
  }

  return version;
}

function listSemverTags(rootDir: string): string[] {
  const result = Bun.spawnSync(["git", "tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"], {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    fail(stderr.length > 0 ? stderr : "Unable to list git tags");
  }

  const tagsOutput = result.stdout.toString().trim();
  if (!tagsOutput) {
    return [];
  }

  return tagsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^v\d+\.\d+\.\d+$/.test(line));
}

function latestSemverTag(rootDir: string): {
  tag: string;
  version: ParsedSemver;
} | null {
  const latestTag = listSemverTags(rootDir)
    .map((tag) => ({
      tag,
      version: parseSemver(tag.slice(1)),
    }))
    .filter((entry): entry is { tag: string; version: ParsedSemver } => entry.version !== null)
    .sort((left, right) => compareSemver(left.version, right.version))
    .at(-1);

  return latestTag ?? null;
}

function readGitCommitMessages(rootDir: string, range: string): string {
  const result = Bun.spawnSync(["git", "log", "--format=%s%n%b", range], {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    fail(stderr.length > 0 ? stderr : `Unable to read git log for range ${range}`);
  }

  return result.stdout.toString();
}

function resolveReleaseBumpLevel(commitMessages: string): "major" | "minor" | "patch" {
  if (/(^|\n).*!:/.test(commitMessages) || /\bBREAKING CHANGE\b/.test(commitMessages)) {
    return "major";
  }

  if (/(^|\n)feat(\([^)]+\))?:/.test(commitMessages)) {
    return "minor";
  }

  return "patch";
}

function resolveArgValue(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function resolveNextReleaseVersion(rootDir: string, defaultVersion: string, ref: string): string {
  const latest = latestSemverTag(rootDir);
  if (!latest) {
    return defaultVersion;
  }

  const range = `${latest.tag}..${ref}`;
  const commitMessages = readGitCommitMessages(rootDir, range);
  if (commitMessages.trim().length === 0) {
    return formatSemver(latest.version);
  }

  const bumpLevel = resolveReleaseBumpLevel(commitMessages);
  const next = bumpSemver(latest.version, bumpLevel);
  return formatSemver(next);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const rootDir = path.resolve(import.meta.dir, "..");
  const version = await readVersion(rootDir);

  if (args.has("--check-increment")) {
    const nextVersion = parseSemver(version);
    if (!nextVersion) {
      fail(`Invalid semantic version '${version}'`);
    }

    const latestTag = latestSemverTag(rootDir);

    if (latestTag && compareSemver(nextVersion, latestTag.version) <= 0) {
      fail(
        `Version ${version} must be greater than latest release tag ${formatSemver(latestTag.version)}. Bump package.json before releasing.`,
      );
    }
  }

  if (args.has("--next-release")) {
    const ref = resolveArgValue(rawArgs, "--ref") ?? "HEAD";
    const nextReleaseVersion = resolveNextReleaseVersion(rootDir, version, ref);
    process.stdout.write(`${nextReleaseVersion}\n`);
    return;
  }

  if (args.has("--next-release-tag")) {
    const ref = resolveArgValue(rawArgs, "--ref") ?? "HEAD";
    const nextReleaseVersion = resolveNextReleaseVersion(rootDir, version, ref);
    process.stdout.write(`v${nextReleaseVersion}\n`);
    return;
  }

  if (args.has("--tag")) {
    process.stdout.write(`v${version}\n`);
    return;
  }

  process.stdout.write(`${version}\n`);
}

await main();
