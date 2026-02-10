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

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const rootDir = path.resolve(import.meta.dir, "..");
  const version = await readVersion(rootDir);

  if (args.has("--check-increment")) {
    const nextVersion = parseSemver(version);
    if (!nextVersion) {
      fail(`Invalid semantic version '${version}'`);
    }

    const latestTag = listSemverTags(rootDir)
      .map((tag) => tag.slice(1))
      .map((tagVersion) => ({
        tagVersion,
        parsed: parseSemver(tagVersion),
      }))
      .filter(
        (entry): entry is { tagVersion: string; parsed: ParsedSemver } => entry.parsed !== null,
      )
      .sort((left, right) => compareSemver(left.parsed, right.parsed))
      .at(-1);

    if (latestTag && compareSemver(nextVersion, latestTag.parsed) <= 0) {
      fail(
        `Version ${version} must be greater than latest release tag ${latestTag.tagVersion}. Bump package.json before releasing.`,
      );
    }
  }

  if (args.has("--tag")) {
    process.stdout.write(`v${version}\n`);
    return;
  }

  process.stdout.write(`${version}\n`);
}

await main();
