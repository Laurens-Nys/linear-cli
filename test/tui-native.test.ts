import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultNativeDir, embeddedNativeLibrary, materializeNativeLibrary } from "../src/tui/native.ts";

function namedBlob(name: string, bytes: Uint8Array): Blob & { name: string } {
  return Object.assign(new Blob([bytes]), { name });
}

describe("TUI native library extraction", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("default dest is /tmp on POSIX so Infisical's sandbox can write it", () => {
    if (process.platform === "win32") return;
    expect(defaultNativeDir()).toBe("/tmp/lin-opentui");
  });

  test("ignores missing names and non-native blobs", () => {
    expect(embeddedNativeLibrary([])).toBeUndefined();
    expect(embeddedNativeLibrary([namedBlob("parser.worker.js", new Uint8Array([1]))])).toBeUndefined();
    expect(embeddedNativeLibrary([new Blob([new Uint8Array([1])])])).toBeUndefined();
  });

  test("matches OpenTUI's compiled native library names", () => {
    expect(embeddedNativeLibrary([namedBlob("libopentui-baxzgttp.dylib", new Uint8Array([1]))])?.name)
      .toBe("libopentui-baxzgttp.dylib");
    expect(embeddedNativeLibrary([namedBlob("libopentui.so", new Uint8Array([1]))])?.name).toBe("libopentui.so");
    expect(embeddedNativeLibrary([namedBlob("opentui.dll", new Uint8Array([1]))])?.name).toBe("opentui.dll");
  });

  test("writes the embedded blob to a real path and skips a same-size copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lin-opentui-"));
    dirs.push(dir);
    const bytes = new Uint8Array([7, 8, 9, 10]);
    const dest = await materializeNativeLibrary([namedBlob("libopentui.dylib", bytes)], dir);
    expect(dest).toBe(join(dir, "libopentui.dylib"));
    expect(readFileSync(dest!)).toEqual(Buffer.from(bytes));

    writeFileSync(dest!, Buffer.from([1, 1, 1, 1]));
    const again = await materializeNativeLibrary([namedBlob("libopentui.dylib", bytes)], dir);
    expect(again).toBe(dest);
    expect(readFileSync(dest!)).toEqual(Buffer.from([1, 1, 1, 1]));

    const larger = new Uint8Array([1, 2, 3, 4, 5]);
    await materializeNativeLibrary([namedBlob("libopentui.dylib", larger)], dir);
    expect(readFileSync(dest!)).toEqual(Buffer.from(larger));
    expect(existsSync(dest!)).toBe(true);
  });

  test("returns undefined when the compiled binary did not embed a native library", async () => {
    expect(await materializeNativeLibrary([])).toBeUndefined();
  });
});
