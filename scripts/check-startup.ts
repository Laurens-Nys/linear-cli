#!/usr/bin/env bun
// Host-binary smoke and generous startup budget. Warmup plus several runs;
// this is a hang/regression tripwire, not a micro-benchmark.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

export const DEFAULT_BINARY = "dist/lin";
export const STARTUP_WARMUPS = 1;
export const STARTUP_RUNS = 3;
export const STARTUP_MAX_MS = 5_000;

export interface TimedRun {
  ms: number;
  stdout: string;
  stderr: string;
  code: number | null;
}

function fail(message: string): never {
  throw new Error(message);
}

export async function timeLin(binary: string, args: readonly string[], timeoutMs: number = STARTUP_MAX_MS + 2_000): Promise<TimedRun> {
  const started = performance.now();
  const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${binary} ${args.join(" ")} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });

  return {
    ms: performance.now() - started,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    code,
  };
}

export async function assertStartup(binary: string = DEFAULT_BINARY): Promise<{ versionMs: number[]; helpMs: number }> {
  if (!existsSync(binary)) fail(`binary not found: ${binary}`);

  for (let i = 0; i < STARTUP_WARMUPS; i += 1) {
    const warm = await timeLin(binary, ["--version"]);
    if (warm.code !== 0) fail(`${binary} --version warmup exited ${warm.code}`);
  }

  const versionMs: number[] = [];
  for (let i = 0; i < STARTUP_RUNS; i += 1) {
    const run = await timeLin(binary, ["--version"]);
    if (run.code !== 0) fail(`${binary} --version exited ${run.code}`);
    if (!/^\d+\.\d+\.\d+/.test(run.stdout.trim())) {
      fail(`${binary} --version printed an unexpected version: ${JSON.stringify(run.stdout)}`);
    }
    if (run.ms > STARTUP_MAX_MS) {
      fail(`${binary} --version took ${Math.round(run.ms)}ms; budget is ${STARTUP_MAX_MS}ms after warmup`);
    }
    versionMs.push(run.ms);
  }

  const help = await timeLin(binary, ["--help"]);
  if (help.code !== 0) fail(`${binary} --help exited ${help.code}`);
  if (!help.stdout.includes("usage: lin")) fail(`${binary} --help missing usage line`);
  if (help.ms > STARTUP_MAX_MS) {
    fail(`${binary} --help took ${Math.round(help.ms)}ms; budget is ${STARTUP_MAX_MS}ms`);
  }

  return { versionMs, helpMs: help.ms };
}

if (import.meta.main) {
  const binary = process.argv[2] ?? DEFAULT_BINARY;
  const result = await assertStartup(binary);
  const versions = result.versionMs.map((ms) => `${Math.round(ms)}ms`).join(", ");
  console.log(`${binary}: --version ${versions}; --help ${Math.round(result.helpMs)}ms (max ${STARTUP_MAX_MS}ms)`);
}
