import { EXIT, LinError } from "../out.ts";
import { defineCommand, flagBool } from "../registry.ts";

export function isInteractiveTerminal(
  stdin: Pick<NodeJS.ReadStream, "isTTY"> = process.stdin,
  stdout: Pick<NodeJS.WriteStream, "isTTY"> = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

export const tuiCommand = defineCommand({
  name: "tui",
  group: "meta",
  summary: "browse my assigned issues and drag them across a terminal Kanban board",
  examples: ["lin tui", "lin tui --limit 25"],
  async run({ config, flags }) {
    if (!isInteractiveTerminal()) {
      throw new LinError(
        EXIT.input,
        "tui needs an interactive terminal",
        "run lin tui directly in a terminal; use lin ls for pipe-friendly output",
      );
    }
    const { runTui } = await import("../tui/run.ts");
    await runTui({ limit: config.limit ?? 50, team: config.team, noCache: flagBool(flags, "no-cache") });
  },
});
