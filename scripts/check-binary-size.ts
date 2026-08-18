#!/usr/bin/env bun
// Deterministic compiled-binary size budget. No extra dependencies.

import { existsSync, statSync } from "node:fs";

/** 96 MiB: current host binary is ~75 MiB, enough headroom without hiding a fat dep. */
export const MAX_BINARY_BYTES = 96 * 1024 * 1024;
export const DEFAULT_BINARY = "dist/lin";

export function binarySize(path: string): number {
  if (!existsSync(path)) {
    throw new Error(`binary not found: ${path}`);
  }
  const size = statSync(path).size;
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`binary ${path} has unusable size ${size}`);
  }
  return size;
}

export function assertBinarySize(path: string = DEFAULT_BINARY, maxBytes: number = MAX_BINARY_BYTES): number {
  const size = binarySize(path);
  if (size > maxBytes) {
    throw new Error(`${path} is ${size} bytes; budget is ${maxBytes}`);
  }
  return size;
}

if (import.meta.main) {
  const path = process.argv[2] ?? DEFAULT_BINARY;
  const size = assertBinarySize(path);
  console.log(`${path}: ${size} bytes (max ${MAX_BINARY_BYTES})`);
}
