/** Linear's documented desktop protocol: `linear://` plus the rest of the https URL. */
export function linearAppUrl(webUrl: string): string {
  return webUrl.replace(/^https:\/\//i, "linear://");
}

export function openCommand(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["open"];
  if (platform === "win32") return ["cmd", "/c", "start", ""];
  return ["xdg-open"];
}

export async function openExternalUrl(url: string): Promise<void> {
  const proc = Bun.spawn([...openCommand(), url], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code === 0) return;
  const stderr = (await new Response(proc.stderr).text()).trim();
  throw new Error(stderr || `could not open ${url}`);
}
