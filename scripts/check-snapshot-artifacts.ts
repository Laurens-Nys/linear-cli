#!/usr/bin/env bun
// Inspect a GoReleaser snapshot dist/ for the four packaged archives,
// checksums.txt, and a `lin` member in each archive. Never execute binaries.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_DIST = "dist";
export const CHECKSUMS_NAME = "checksums.txt";

export interface ArchiveTarget {
  id: string;
  os: string;
  arches: readonly string[];
}

/** GoReleaser maps bun `x64` targets to `amd64`; accept both names. */
export const REQUIRED_ARCHIVE_TARGETS: readonly ArchiveTarget[] = [
  { id: "darwin_arm64", os: "darwin", arches: ["arm64"] },
  { id: "darwin_amd64", os: "darwin", arches: ["amd64", "x64", "x86_64"] },
  { id: "linux_amd64", os: "linux", arches: ["amd64", "x64", "x86_64"] },
  { id: "linux_arm64", os: "linux", arches: ["arm64"] },
];

function fail(message: string): never {
  throw new Error(message);
}

export function matchesArchiveTarget(name: string, target: ArchiveTarget): boolean {
  const lower = name.toLowerCase();
  if (!lower.startsWith("lin_") || !lower.endsWith(".tar.gz")) return false;
  return target.arches.some((arch) => lower.endsWith(`_${target.os}_${arch}.tar.gz`));
}

export function listTarMembers(archive: string): string[] {
  const result = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`tar -tzf ${archive} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function archiveHasLinBinary(members: readonly string[]): boolean {
  return members.some((member) => basename(member.replace(/\/+$/, "")) === "lin");
}

export function assertSnapshotArtifacts(dist: string = DEFAULT_DIST): { checksums: string; archives: string[] } {
  if (!existsSync(dist) || !statSync(dist).isDirectory()) fail(`snapshot dist not found: ${dist}`);

  const checksums = join(dist, CHECKSUMS_NAME);
  if (!existsSync(checksums) || !statSync(checksums).isFile()) {
    fail(`missing ${CHECKSUMS_NAME} in ${dist}`);
  }

  const tarballs = readdirSync(dist).filter((name) => {
    if (!name.endsWith(".tar.gz") || name.startsWith(".")) return false;
    return statSync(join(dist, name)).isFile();
  });
  const archives: string[] = [];

  for (const target of REQUIRED_ARCHIVE_TARGETS) {
    const matches = tarballs.filter((name) => matchesArchiveTarget(name, target));
    if (matches.length !== 1) {
      fail(`expected exactly one ${target.id} archive in ${dist}, found ${JSON.stringify(matches)}`);
    }
    archives.push(matches[0]!);
  }

  const unexpected = tarballs.filter((name) => !archives.includes(name));
  if (unexpected.length > 0) fail(`unexpected snapshot archives: ${unexpected.join(", ")}`);

  const checksumText = readFileSync(checksums, "utf8");
  for (const archive of archives) {
    if (!checksumText.includes(archive)) fail(`${CHECKSUMS_NAME} does not mention ${archive}`);
    const members = listTarMembers(join(dist, archive));
    if (!archiveHasLinBinary(members)) fail(`${archive} does not contain a lin binary`);
  }

  return { checksums, archives };
}

if (import.meta.main) {
  const dist = process.argv[2] ?? DEFAULT_DIST;
  const result = assertSnapshotArtifacts(dist);
  console.log(`${dist}: ${result.archives.join(", ")}; ${CHECKSUMS_NAME}`);
}
