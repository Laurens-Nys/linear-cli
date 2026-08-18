import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { MAX_BINARY_BYTES, assertBinarySize, binarySize } from "../scripts/check-binary-size.ts";
import {
  REQUIRED_ARCHIVE_TARGETS,
  archiveHasLinBinary,
  assertSnapshotArtifacts,
  matchesArchiveTarget,
} from "../scripts/check-snapshot-artifacts.ts";
import { STARTUP_MAX_MS, STARTUP_RUNS, STARTUP_WARMUPS } from "../scripts/check-startup.ts";
import { sandbox } from "./harness.ts";

const ROOT = join(import.meta.dir, "..");

function readRepo(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function workflowJob(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`missing job ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function writeArchive(dir: string, name: string, members: readonly string[] = ["lin", "LICENSE"]): void {
  const staging = join(dir, `.staging-${name}`);
  mkdirSync(staging, { recursive: true });
  for (const member of members) {
    writeFileSync(join(staging, member), member === "lin" ? "not-a-binary" : member);
  }
  const packed = spawnSync("tar", ["-czf", join(dir, name), "-C", staging, ...members], { encoding: "utf8" });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || `tar failed for ${name}`);
}

describe("CI matrix", () => {
  const ci = readRepo(".github/workflows/ci.yml");

  test("typechecks, tests, and builds on Linux and macOS hosts", () => {
    expect(ci).toContain("os: [ubuntu-latest, macos-latest]");
    expect(ci).toContain("bun-version: 1.3.14");
    expect(ci).toContain("bun install --frozen-lockfile --os=\"*\" --cpu=\"*\"");
    expect(ci).toContain("bunx tsc --noEmit");
    expect(ci).toContain("bun test");
    expect(ci).toContain("bun run build");
    expect(ci).toContain("bun run check:size");
    expect(ci).toContain("bun run check:startup");
    expect(ci).not.toContain("windows-latest");
    expect(ci).not.toContain("ubuntu-24.04-arm");
    expect(ci).not.toContain("macos-13");
  });

  test("validates GoReleaser and snapshots without publishing or executing binaries", () => {
    expect(ci).toContain("version: \"~> v2.10\"");
    expect(ci).not.toContain("version: \"~> v2\"");
    expect(ci).toContain("args: check");
    expect(ci).toContain("args: release --snapshot --skip=publish --clean");
    expect(ci).toContain("bun scripts/check-snapshot-artifacts.ts");
    expect(ci).not.toMatch(/args: release --clean\s*$/m);
    expect(ci).not.toMatch(/dist\/lin_(darwin|linux)/);
  });
});

describe("release safety", () => {
  const release = readRepo(".github/workflows/release.yml");
  const goreleaser = readRepo(".goreleaser.yaml");
  const dryRun = workflowJob(release, "dry-run");
  const guard = workflowJob(release, "guard");
  const publish = workflowJob(release, "publish");

  test("workflow default and dry-run stay contents:read", () => {
    expect(release).toMatch(/^permissions:\n  contents: read$/m);
    expect(release).not.toMatch(/^permissions:\n  contents: write$/m);
    expect(dryRun).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(dryRun).toMatch(/permissions:\n      contents: read/);
    expect(dryRun).not.toContain("contents: write");
    expect(dryRun).toContain("version: \"~> v2.10\"");
    expect(dryRun).toContain("args: release --snapshot --skip=publish --clean");
    expect(dryRun).toContain("bun scripts/check-snapshot-artifacts.ts");
    expect(dryRun).not.toMatch(/args: release --clean\s*$/m);
    expect(dryRun).not.toContain("environment: release");
    expect(dryRun).not.toContain("GITHUB_TOKEN");
    expect(dryRun).not.toContain("HOMEBREW_TAP_TOKEN");
  });

  test("blocked tag pushes fail closed in a read-only guard job", () => {
    expect(guard).toContain("if: github.event_name == 'push' && vars.LIN_RELEASE_PUBLISH != 'true'");
    expect(guard).toMatch(/permissions:\n      contents: read/);
    expect(guard).not.toContain("contents: write");
    expect(guard).toContain("Release publish is blocked.");
    expect(guard).not.toContain("args: release --clean");
    expect(guard).not.toContain("environment: release");
    expect(guard).not.toContain("HOMEBREW_TAP_TOKEN");
  });

  test("publish is tag-only, environment-gated, and the only writer", () => {
    expect(publish).toContain("if: github.event_name == 'push' && vars.LIN_RELEASE_PUBLISH == 'true'");
    expect(publish).toContain("environment: release");
    expect(publish).toMatch(/permissions:\n      contents: write/);
    expect(publish).toContain("args: release --clean");
    expect(publish).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
    expect(publish).not.toContain("workflow_dispatch");
    expect(publish).not.toContain("HOMEBREW_TAP_TOKEN");
    expect(publish).not.toContain("needs:");
    expect(release).not.toContain("if: github.event_name == 'workflow_dispatch' && vars.LIN_RELEASE_PUBLISH");
    expect(dryRun).not.toContain("contents: write");
    expect(guard).not.toContain("contents: write");
  });

  test("GoReleaser keeps the tap unpublished until skip_upload is changed", () => {
    expect(goreleaser).toContain("skip_upload: true");
    expect(goreleaser).not.toContain("skip_upload: auto");
    expect(goreleaser).toContain("# token: \"{{ .Env.HOMEBREW_TAP_TOKEN }}\"");
    expect(goreleaser).not.toMatch(/^\s+token:/m);
    expect(goreleaser).toContain("LIN_RELEASE_PUBLISH");
    expect(goreleaser).toContain("`~> v2.10`");
    expect(goreleaser).toContain("darwin-arm64");
    expect(goreleaser).toContain("darwin-x64");
    expect(goreleaser).toContain("linux-x64");
    expect(goreleaser).toContain("linux-arm64");
    expect(goreleaser).not.toContain("windows");
  });
});

describe("live smoke", () => {
  const smoke = readRepo(".github/workflows/live-smoke.yml");

  test("is manual, read-only, secret-gated, and output-quiet", () => {
    expect(smoke).toContain("workflow_dispatch:");
    expect(smoke).not.toContain("push:");
    expect(smoke).not.toContain("pull_request:");
    expect(smoke).toContain("secrets.LINEAR_API_KEY");
    expect(smoke).toContain("live smoke requires repository secret LINEAR_API_KEY");
    expect(smoke).toContain('check "lin auth" ./dist/lin auth');
    expect(smoke).toContain('check "lin doctor" ./dist/lin doctor');
    expect(smoke).toContain('check "lin cache warm" ./dist/lin cache warm');
    expect(smoke).toContain('check "lin team list" ./dist/lin team list');
    expect(smoke).toContain('check "lin ls -n 5" ./dist/lin ls -n 5');
    expect(smoke).toContain('check "lin today -n 5" ./dist/lin today -n 5');
    expect(smoke).toContain('if ! "$@" >/dev/null 2>&1; then');
    expect(smoke).toContain('echo "$label failed"');
    expect(smoke).not.toContain("echo \"$LINEAR_API_KEY\"");
    expect(smoke).not.toContain("echo \"${LINEAR_API_KEY}\"");
    expect(smoke).not.toMatch(/^\s*\.\/dist\/lin (auth|doctor|cache warm|team list|ls -n 5|today -n 5)\s*$/m);
    for (const banned of [
      "lin start",
      "lin done",
      "issue create",
      "issue update",
      "issue delete",
      "comment add",
      "inbox archive",
    ]) {
      expect(smoke).not.toContain(banned);
    }
  });
});

describe("snapshot artifacts", () => {
  const checker = readRepo("scripts/check-snapshot-artifacts.ts");

  test("the checker lists archives and never executes lin", () => {
    expect(REQUIRED_ARCHIVE_TARGETS.map((target) => target.id)).toEqual([
      "darwin_arm64",
      "darwin_amd64",
      "linux_amd64",
      "linux_arm64",
    ]);
    expect(matchesArchiveTarget("lin_0.1.0-SNAPSHOT_darwin_arm64.tar.gz", REQUIRED_ARCHIVE_TARGETS[0]!)).toBe(true);
    expect(matchesArchiveTarget("lin_0.1.0-SNAPSHOT_darwin_amd64.tar.gz", REQUIRED_ARCHIVE_TARGETS[1]!)).toBe(true);
    expect(matchesArchiveTarget("lin_0.1.0-SNAPSHOT_linux_amd64.tar.gz", REQUIRED_ARCHIVE_TARGETS[2]!)).toBe(true);
    expect(matchesArchiveTarget("lin_0.1.0-SNAPSHOT_linux_arm64.tar.gz", REQUIRED_ARCHIVE_TARGETS[3]!)).toBe(true);
    expect(archiveHasLinBinary(["README.md", "lin", "LICENSE"])).toBe(true);
    expect(checker).toContain('tar", ["-tzf"');
    expect(checker).not.toMatch(/spawn(?:Sync)?\([^)]*lin/);
    expect(checker).not.toContain("./lin");
  });

  test("accepts the four archives, checksums, and lin members", () => {
    const box = sandbox();
    try {
      const archives = [
        "lin_0.1.0-SNAPSHOT_darwin_arm64.tar.gz",
        "lin_0.1.0-SNAPSHOT_darwin_amd64.tar.gz",
        "lin_0.1.0-SNAPSHOT_linux_amd64.tar.gz",
        "lin_0.1.0-SNAPSHOT_linux_arm64.tar.gz",
      ];
      for (const archive of archives) writeArchive(box.dir, archive);
      writeFileSync(join(box.dir, "checksums.txt"), archives.map((name) => `deadbeef  ${name}`).join("\n"));
      expect(assertSnapshotArtifacts(box.dir).archives).toEqual(archives);
    } finally {
      box.cleanup();
    }
  });

  test("rejects a missing platform, extra archive, or archive without lin", () => {
    const box = sandbox();
    try {
      writeArchive(box.dir, "lin_0.1.0-SNAPSHOT_darwin_arm64.tar.gz");
      writeArchive(box.dir, "lin_0.1.0-SNAPSHOT_darwin_amd64.tar.gz");
      writeArchive(box.dir, "lin_0.1.0-SNAPSHOT_linux_amd64.tar.gz");
      writeFileSync(join(box.dir, "checksums.txt"), "incomplete\n");
      expect(() => assertSnapshotArtifacts(box.dir)).toThrow(/linux_arm64/);

      writeArchive(box.dir, "lin_0.1.0-SNAPSHOT_linux_arm64.tar.gz");
      writeArchive(box.dir, "lin_0.1.0-SNAPSHOT_windows_amd64.tar.gz");
      writeFileSync(
        join(box.dir, "checksums.txt"),
        "lin_0.1.0-SNAPSHOT_darwin_arm64.tar.gz\nlin_0.1.0-SNAPSHOT_darwin_amd64.tar.gz\nlin_0.1.0-SNAPSHOT_linux_amd64.tar.gz\nlin_0.1.0-SNAPSHOT_linux_arm64.tar.gz\n",
      );
      expect(() => assertSnapshotArtifacts(box.dir)).toThrow(/unexpected snapshot archives/);

      const empty = sandbox();
      try {
        writeArchive(empty.dir, "lin_0.1.0-SNAPSHOT_darwin_arm64.tar.gz", ["LICENSE"]);
        writeArchive(empty.dir, "lin_0.1.0-SNAPSHOT_darwin_amd64.tar.gz");
        writeArchive(empty.dir, "lin_0.1.0-SNAPSHOT_linux_amd64.tar.gz");
        writeArchive(empty.dir, "lin_0.1.0-SNAPSHOT_linux_arm64.tar.gz");
        writeFileSync(
          join(empty.dir, "checksums.txt"),
          "lin_0.1.0-SNAPSHOT_darwin_arm64.tar.gz\nlin_0.1.0-SNAPSHOT_darwin_amd64.tar.gz\nlin_0.1.0-SNAPSHOT_linux_amd64.tar.gz\nlin_0.1.0-SNAPSHOT_linux_arm64.tar.gz\n",
        );
        expect(() => assertSnapshotArtifacts(empty.dir)).toThrow(/does not contain a lin binary/);
      } finally {
        empty.cleanup();
      }
    } finally {
      box.cleanup();
    }
  });
});

describe("budget scripts", () => {
  test("the size script accepts a small file and rejects an oversized one", () => {
    const box = sandbox();
    try {
      const ok = join(box.dir, "ok.bin");
      const big = join(box.dir, "big.bin");
      writeFileSync(ok, "lin");
      expect(binarySize(ok)).toBe(3);
      expect(assertBinarySize(ok, 16)).toBe(3);
      writeFileSync(big, "x".repeat(32));
      expect(() => assertBinarySize(big, 16)).toThrow(/budget is 16/);
    } finally {
      box.cleanup();
    }
  });

  test("startup and size budgets stay generous tripwires", () => {
    expect(MAX_BINARY_BYTES).toBe(96 * 1024 * 1024);
    expect(STARTUP_WARMUPS).toBe(1);
    expect(STARTUP_RUNS).toBe(3);
    expect(STARTUP_MAX_MS).toBe(5_000);
    expect(existsSync(join(ROOT, "scripts/check-binary-size.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts/check-startup.ts"))).toBe(true);
  });
});
