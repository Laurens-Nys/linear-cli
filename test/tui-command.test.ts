import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCommand } from "../src/registry.ts";
import { renderCommandHelp } from "../src/main.ts";
import { isInteractiveTerminal } from "../src/commands/tui.ts";
import { EXIT } from "../src/out.ts";
import { mock, sandbox, type Mock, type Sandbox } from "./harness.ts";

let box: Sandbox;
let net: Mock;

beforeEach(() => {
  box = sandbox();
  net = mock([]);
});

afterEach(() => {
  net.restore();
  box.cleanup();
});

describe("tui command", () => {
  test("is registered and documented through the command registry", () => {
    const command = getCommand("tui");
    expect(command).toBeDefined();
    expect(renderCommandHelp(command!)).toContain("lin tui — browse my assigned issues");
    expect(renderCommandHelp(command!)).toContain("lin tui --limit 25");
  });

  test("rejects non-TTY use without loading OpenTUI modules", async () => {
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractiveTerminal({ isTTY: false }, { isTTY: true })).toBe(false);

    const process = Bun.spawn(["bun", "test/fixtures/tui-lazy-load.ts"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, NO_COLOR: "1" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim())).toEqual({
      before: { run: false, core: false },
      after: { run: false, core: false },
      exitCode: EXIT.input,
    });
    expect(net.calls).toHaveLength(0);
  });
});
