import { dlopen } from "bun:ffi";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NATIVE_NAME = /(?:^|\/)(?:libopentui[^/]*\.(?:dylib|so)|opentui\.dll)$/i;

export function defaultNativeDir(): string {
  return process.platform === "win32" ? join(tmpdir(), "lin-opentui") : "/tmp/lin-opentui";
}

export function embeddedNativeLibrary(
  files: ReadonlyArray<Blob & { name?: string }> = Bun.embeddedFiles,
): (Blob & { name: string }) | undefined {
  return files.find((file): file is Blob & { name: string } =>
    typeof file.name === "string" && NATIVE_NAME.test(file.name),
  );
}

/**
 * Bun compile embeds OpenTUI's native library in `$bunfs`, which `dlopen` cannot
 * see inside Infisical's agent-proxy sandbox. Copy it to a real, writable path.
 */
export async function materializeNativeLibrary(
  files: ReadonlyArray<Blob & { name?: string }> = Bun.embeddedFiles,
  destDir: string = defaultNativeDir(),
): Promise<string | undefined> {
  const blob = embeddedNativeLibrary(files);
  if (!blob) return undefined;
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, blob.name);
  if (!existsSync(dest) || statSync(dest).size !== blob.size) {
    await Bun.write(dest, blob);
    chmodSync(dest, 0o755);
  }
  return dest;
}

/** Map the extracted library into the process, then unload it. Does not start a TUI. */
export function loadNativeLibrary(path: string): void {
  // bun:ffi refuses an empty symbol table. Bind one exported OpenTUI symbol and
  // never call it — that would construct a renderer.
  const lib = dlopen(path, {
    createRenderer: { args: [], returns: "ptr" },
  });
  lib.close();
}

export async function prepareNativeRenderer(): Promise<void> {
  try {
    const dest = await materializeNativeLibrary();
    if (dest) {
      const { setRenderLibPath } = await import("@opentui/core");
      setRenderLibPath(dest);
    }
  } catch {
    // Keep OpenTUI's default path; createCliRenderer reports the real failure.
  }
}
