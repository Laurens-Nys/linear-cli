import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import doctor from "../src/commands/doctor.ts";
import { cacheRoot, toMeta, writeCached } from "../src/cache.ts";
import { MISSING_API_KEY_HINT, keyFingerprint } from "../src/client.ts";
import {
  checkApiKey,
  checkCache,
  checkConfig,
  checkFonts,
  checkLinear,
  checkNative,
  checkRate,
  findFontMatches,
  fontSearchRoots,
  probeCacheWrite,
  runDoctor,
} from "../src/doctor.ts";
import { run } from "../src/main.ts";
import { EXIT, LinError, renderTable } from "../src/out.ts";
import { getCommand } from "../src/registry.ts";
import { MISSING_TEAM_HINT } from "../src/resolve.ts";
import { captureStdout, mock, sandbox } from "./harness.ts";
import { RATE_HEADERS, WARM_DATA } from "./fixtures.ts";

const VIEWER = {
  name: "Casey Jordan",
  organization: { urlKey: "acme", name: "Acme" },
};

const SECRET = "lin_api_secret_do_not_print";

const PASSING = {
  queryAuth: async () => VIEWER,
  rateInfo: {
    requestsRemaining: 2487,
    requestsLimit: 2500,
    requestsReset: "2026-07-29 16:00:00Z",
  },
  config: { team: "ENG", limit: 50 },
  materializeNative: async () => undefined,
  fontMatches: () => ["/tmp/MaterialDesignIcons.ttf"],
  remote: false,
  probeWrite: () => ({ ok: true }),
};

function expectLinError(error: unknown): LinError {
  expect(error).toBeInstanceOf(LinError);
  return error as LinError;
}

describe("individual checks", () => {
  test("api-key pass never includes the value", () => {
    const row = checkApiKey({ LINEAR_API_KEY: SECRET });
    expect(row).toEqual({ check: "api-key", status: "pass", detail: "set", fix: "" });
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  test("api-key fail names the settings path and export without a fake secret", () => {
    const row = checkApiKey({});
    expect(row.status).toBe("fail");
    expect(row.detail).toBe("not set");
    expect(row.fix).toBe(MISSING_API_KEY_HINT);
    expect(row.fix).toContain("Linear Settings > Security & access > Personal API keys");
    expect(row.fix).toContain("export LINEAR_API_KEY");
    expect(row.fix).not.toContain("lin_api");
    expect(checkApiKey({ LINEAR_API_KEY: "   " }).status).toBe("fail");
  });

  test("linear pass, skip, and fail are distinct", async () => {
    expect(await checkLinear({ hasKey: false })).toMatchObject({ check: "linear", status: "skip", detail: "no API key" });
    expect(await checkLinear({ hasKey: true, queryAuth: async () => VIEWER })).toMatchObject({
      status: "pass",
      detail: "Casey Jordan @ acme",
    });
    expect(
      await checkLinear({
        hasKey: true,
        queryAuth: async () => {
          throw new LinError(EXIT.api, "could not reach the Linear API: offline", "check network connectivity and retry");
        },
      }),
    ).toMatchObject({
      status: "fail",
      detail: "could not reach the Linear API: offline",
      fix: "check network connectivity and retry",
    });
  });

  test("rate pass uses headers, skip has none, warn is exhausted", () => {
    expect(checkRate(null)).toMatchObject({ status: "skip", detail: "no rate headers" });
    expect(
      checkRate({
        requestsRemaining: 2487,
        requestsLimit: 2500,
        requestsReset: "2026-07-29 16:00:00Z",
      }),
    ).toMatchObject({
      status: "pass",
      detail: "2487/2500 requests, reset 2026-07-29 16:00:00Z",
    });
    expect(checkRate({ requestsRemaining: 0, requestsLimit: 2500 })).toMatchObject({
      status: "warn",
      fix: "wait for the rate limit window to reset",
    });
  });

  test("config pass, missing-team warn, and invalid fail", () => {
    expect(checkConfig({ config: { team: "ENG", limit: 50 } })).toMatchObject({
      status: "pass",
      detail: "team ENG",
    });
    expect(checkConfig({ config: { limit: 50 } })).toMatchObject({
      status: "warn",
      detail: "no default team",
      fix: MISSING_TEAM_HINT,
    });
    expect(
      checkConfig({
        loadConfig: () => {
          throw new LinError(EXIT.input, '/tmp/.lin.toml:1: unknown key color', "supported keys: team, limit");
        },
      }),
    ).toMatchObject({
      status: "fail",
      detail: "/tmp/.lin.toml:1: unknown key color",
      fix: "supported keys: team, limit",
    });
  });

  test("native skip, pass, and fail", async () => {
    expect(await checkNative({ materialize: async () => undefined })).toMatchObject({
      status: "skip",
      detail: "no embedded native library",
    });
    const box = sandbox();
    try {
      const dest = join(box.dir, "libopentui.dylib");
      writeFileSync(dest, "native");
      expect(await checkNative({ materialize: async () => dest, load: () => undefined })).toMatchObject({
        status: "pass",
        detail: dest,
      });
      expect(await checkNative({ materialize: async () => dest })).toMatchObject({
        status: "fail",
        fix: "delete /tmp/lin-opentui and rerun lin doctor, or reinstall lin",
      });
      expect(
        await checkNative({
          materialize: async () => dest,
          load: () => {
            throw new Error("dlopen failed");
          },
        }),
      ).toMatchObject({ status: "fail", detail: "dlopen failed" });
      expect(await checkNative({ materialize: async () => join(box.dir, "missing.dylib") })).toMatchObject({
        status: "fail",
        detail: "extracted library is missing or empty",
      });
      expect(
        await checkNative({
          materialize: async () => {
            throw new Error("disk full");
          },
        }),
      ).toMatchObject({ status: "fail", detail: "disk full" });
    } finally {
      box.cleanup();
    }
  });

  test("native loadability uses the real packaged OpenTUI library without a TUI", async () => {
    const lib =
      process.platform === "win32"
        ? "opentui.dll"
        : process.platform === "darwin"
          ? "libopentui.dylib"
          : "libopentui.so";
    const dest = join(import.meta.dir, "..", "node_modules", "@opentui", `core-${process.platform}-${process.arch}`, lib);
    expect(await checkNative({ materialize: async () => dest })).toMatchObject({ status: "pass", detail: dest });
  });

  test("fonts pass locally, warn when missing, and warn remotely instead of scanning", () => {
    expect(checkFonts({ remote: false, fontMatches: () => ["/Library/Fonts/MaterialDesignIcons.ttf"] })).toMatchObject({
      status: "pass",
      detail: "/Library/Fonts/MaterialDesignIcons.ttf",
    });
    expect(checkFonts({ remote: false, fontMatches: () => [] })).toMatchObject({
      status: "warn",
      detail: "Material Design Icons not found",
    });
    expect(checkFonts({ env: { HERDR_ENV: "1" }, fontMatches: () => ["/secret/MaterialDesignIcons.ttf"] })).toMatchObject({
      status: "warn",
      detail: "terminal is rendered on another machine",
      fix: "install Material Design Icons on the client Mac, not this host",
    });
    expect(checkFonts({ env: { SSH_CONNECTION: "1 2 3 4" }, fontMatches: () => [] })).toMatchObject({
      status: "warn",
      detail: "terminal is rendered on another machine",
    });
    expect(checkFonts({ remote: true, fontMatches: () => { throw new Error("should not scan"); } })).toMatchObject({
      status: "warn",
    });
  });

  test("font scan walks injected platform roots and still warns remotely", () => {
    const box = sandbox();
    try {
      const fonts = join(box.dir, "Library", "Fonts", "Vendor");
      mkdirSync(fonts, { recursive: true });
      writeFileSync(join(box.dir, "Library", "Fonts", "README.txt"), "ignore");
      writeFileSync(join(box.dir, "Library", "Fonts", "Arial.ttf"), "ignore");
      const match = join(fonts, "MaterialDesignIcons-Regular.otf");
      writeFileSync(match, "font");
      const env = { HOME: box.dir };
      const darwinRoot = join(box.dir, "Library", "Fonts");
      expect(fontSearchRoots(env, "darwin")[0]).toBe(darwinRoot);
      expect(fontSearchRoots(env, "linux")[0]).toBe(join(box.dir, ".local", "share", "fonts"));
      expect(findFontMatches(env, "darwin", [darwinRoot])).toEqual([match]);
      expect(findFontMatches(env, "linux", [join(box.dir, ".local", "share", "fonts")])).toEqual([]);
      expect(findFontMatches(env, "darwin", [join(box.dir, "empty")])).toEqual([]);

      expect(checkFonts({ env: { HOME: box.dir, SSH_CONNECTION: "1 2 3 4" } })).toMatchObject({
        status: "warn",
        detail: "terminal is rendered on another machine",
        fix: "install Material Design Icons on the client Mac, not this host",
      });
    } finally {
      box.cleanup();
    }
  });
});

describe("cache probe", () => {
  test("creates only an owned probe and deletes it", () => {
    const box = sandbox();
    try {
      const root = cacheRoot(box.env);
      const result = probeCacheWrite(root);
      expect(result.ok).toBe(true);
      expect(readdirSync(root).filter((name) => name.startsWith(".lin-doctor-"))).toEqual([]);
    } finally {
      box.cleanup();
    }
  });

  test("an unwritable root is a warning and still leaves no probe", () => {
    const box = sandbox();
    const root = join(box.dir, "blocked");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o555);
    try {
      const result = probeCacheWrite(root);
      expect(result.ok).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith(".lin-doctor-"))).toEqual([]);
      expect(
        checkCache({
          env: box.env,
          probeWrite: () => result,
          readCache: () => null,
        }),
      ).toMatchObject({ status: "warn", detail: "empty, not writable" });
    } finally {
      chmodSync(root, 0o755);
      box.cleanup();
    }
  });

  test("fresh cache is a pass and stale cache is a warn", () => {
    const box = sandbox();
    try {
      const now = Date.parse("2026-08-01T12:00:00.000Z");
      const fresh = toMeta(WARM_DATA, keyFingerprint(box.env), new Date(now));
      expect(
        checkCache({
          env: box.env,
          now,
          readCache: () => fresh,
          probeWrite: () => ({ ok: true }),
        }),
      ).toMatchObject({ status: "pass", detail: "acme, age 0m, writable" });

      const stale = { ...fresh, fetchedAt: "2026-07-01T12:00:00.000Z" };
      expect(
        checkCache({
          env: box.env,
          now,
          readCache: () => stale,
          probeWrite: () => ({ ok: true }),
        }),
      ).toMatchObject({ status: "warn", detail: "acme, age 31d stale, writable", fix: "run lin cache warm" });
    } finally {
      box.cleanup();
    }
  });
});

describe("runDoctor", () => {
  test("prints every check in a stable order and redacts the key everywhere", async () => {
    const box = sandbox({ LINEAR_API_KEY: SECRET });
    try {
      const result = await runDoctor({
        env: { ...box.env, LINEAR_API_KEY: SECRET },
        ...PASSING,
        queryAuth: async () => {
          throw new Error(`denied for ${SECRET}`);
        },
      });
      expect(result.rows.map((row) => row.check)).toEqual([
        "api-key",
        "linear",
        "rate",
        "config",
        "cache",
        "tui-native",
        "fonts",
      ]);
      expect(result.rows[1]).toMatchObject({ status: "fail", detail: "denied for [redacted]" });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    } finally {
      box.cleanup();
    }
  });

  test("rate headers from a real mocked request populate the rate row", async () => {
    const box = sandbox();
    const stub = mock([{ match: "LinDoctorAuth", data: { viewer: VIEWER }, headers: RATE_HEADERS }]);
    try {
      const result = await runDoctor({
        env: box.env,
        config: { team: "ENG", limit: 50 },
        materializeNative: async () => undefined,
        fontMatches: () => ["/tmp/MaterialDesignIcons.ttf"],
        probeWrite: () => ({ ok: true }),
      });
      expect(result.rows.find((row) => row.check === "linear")).toMatchObject({ status: "pass" });
      expect(result.rows.find((row) => row.check === "rate")?.detail).toContain("2487/2500 requests");
      expect(stub.calls.map((call) => call.operation)).toEqual(["LinDoctorAuth"]);
    } finally {
      stub.restore();
      box.cleanup();
    }
  });

  test("warnings do not fail and required failures do", async () => {
    const ok = await runDoctor({
      env: { LINEAR_API_KEY: "lin_api_test_key" },
      ...PASSING,
      config: { limit: 50 },
      readCache: () => null,
    });
    expect(ok.failedRequired).toBe(false);
    expect(ok.rows.find((row) => row.check === "config")?.status).toBe("warn");
    expect(ok.rows.find((row) => row.check === "cache")?.status).toBe("warn");

    const bad = await runDoctor({
      env: {},
      config: { limit: 50 },
      materializeNative: async () => {
        throw new Error("dlopen failed");
      },
      fontMatches: () => [],
      probeWrite: () => ({ ok: true }),
    });
    expect(bad.failedRequired).toBe(true);
    expect(bad.failing).toEqual(["api-key", "tui-native"]);
    expect(bad.rows.find((row) => row.check === "linear")?.status).toBe("skip");
  });

  test("a junk extracted library is a required dlopen failure, not a skip", async () => {
    const box = sandbox();
    try {
      const dest = join(box.dir, "junk.dylib");
      writeFileSync(dest, "not-a-library");
      const junk = await runDoctor({
        env: {},
        config: { limit: 50 },
        materializeNative: async () => dest,
        fontMatches: () => [],
        probeWrite: () => ({ ok: true }),
      });
      expect(junk.failedRequired).toBe(true);
      expect(junk.failing).toContain("tui-native");
      expect(junk.rows.find((row) => row.check === "tui-native")).toMatchObject({
        status: "fail",
        fix: "delete /tmp/lin-opentui and rerun lin doctor, or reinstall lin",
      });
      expect(junk.rows.find((row) => row.check === "tui-native")?.detail).not.toBe(
        "extracted library is missing or empty",
      );
      expect(junk.rows.find((row) => row.check === "tui-native")?.detail).not.toBe("no embedded native library");
    } finally {
      box.cleanup();
    }
  });
});

describe("lin doctor command", () => {
  const boxes: Array<{ cleanup(): void }> = [];
  afterEach(() => {
    for (const box of boxes.splice(0)) box.cleanup();
  });

  test("a clean run prints the table and exits 0, noninteractively", async () => {
    const box = sandbox();
    boxes.push(box);
    writeCached(toMeta(WARM_DATA, keyFingerprint(box.env)), box.env);
    const stub = mock([{ match: "LinDoctorAuth", data: { viewer: VIEWER }, headers: RATE_HEADERS }]);
    const captured = captureStdout();
    try {
      const result = await runDoctor({
        env: box.env,
        config: { team: "ENG", limit: 50 },
        materializeNative: async () => undefined,
        fontMatches: () => ["/tmp/MaterialDesignIcons.ttf"],
      });
      expect(result.failedRequired).toBe(false);

      const code = await (async () => {
        // Drive the command with a passing environment: key set, team set, mocked API.
        process.env.LINEAR_API_KEY = box.env.LINEAR_API_KEY;
        return doctor.run({
          args: [],
          flags: {},
          config: { team: "ENG", limit: 50 },
          command: doctor,
        });
      })();
      captured.restore();
      expect(code).toBeUndefined();
      const text = captured.text();
      expect(text.startsWith("checks[7]{check,status,detail,fix}:")).toBe(true);
      expect(text).toContain("api-key,pass,set,");
      expect(text).toContain("Casey Jordan @ acme");
      expect(text).toContain("2487/2500 requests");
      expect(text).not.toContain("lin_api_test_key");
      expect(process.stdin.isTTY).not.toBe(true);
    } finally {
      captured.restore();
      stub.restore();
    }
  });

  test("multiple required failures still print the full table, then exit 1", async () => {
    const box = sandbox();
    boxes.push(box);
    delete process.env.LINEAR_API_KEY;
    const captured = captureStdout();
    const result = await runDoctor({
      env: {},
      config: { limit: 50 },
      loadConfig: () => {
        throw new LinError(EXIT.input, '/tmp/.lin.toml:1: unknown key color', "supported keys: team, limit");
      },
      materializeNative: async () => {
        throw new Error("dlopen failed");
      },
      fontMatches: () => [],
      probeWrite: () => ({ ok: true }),
    });
    const rendered = renderTable("checks", result.rows, ["check", "status", "detail", "fix"]);
    expect(result.failing).toEqual(["api-key", "config", "tui-native"]);
    expect(rendered).toContain("api-key,fail,not set,");
    expect(rendered).toContain("linear,skip,no API key,");
    expect(rendered).toContain("config,fail,");
    expect(rendered).toContain("tui-native,fail,dlopen failed,");
    expect(rendered.split("\n")[0]).toBe("checks[7]{check,status,detail,fix}:");

    try {
      await doctor.run({
        args: [],
        flags: {},
        config: { limit: 50 },
        command: doctor,
      });
      throw new Error("expected doctor to throw");
    } catch (error) {
      captured.restore();
      const failure = expectLinError(error);
      expect(failure.exitCode).toBe(EXIT.api);
      expect(failure.message).toBe("doctor found failing checks");
      expect(failure.hint).toContain("api-key");
      expect(captured.text().startsWith("checks[7]{check,status,detail,fix}:")).toBe(true);
      expect(captured.text()).toContain("api-key,fail,not set,");
      expect(captured.text()).not.toContain("lin_api");
    } finally {
      captured.restore();
    }
  });

  test("dispatch through main stays automation-safe", async () => {
    const box = sandbox();
    boxes.push(box);
    const stub = mock([{ match: "LinDoctorAuth", data: { viewer: VIEWER }, headers: RATE_HEADERS }]);
    const captured = captureStdout();
    try {
      const code = await run(["doctor"]);
      captured.restore();
      expect(code).toBe(EXIT.ok);
      expect(captured.text()).toContain("checks[7]{check,status,detail,fix}:");
      expect(captured.text()).toContain("tui-native,skip,no embedded native library,");
      expect(captured.text()).not.toContain("\u001b[");
    } finally {
      captured.restore();
      stub.restore();
    }
  });

  test("doctor applies --team after validating config itself", async () => {
    const box = sandbox();
    boxes.push(box);
    const stub = mock([{ match: "LinDoctorAuth", data: { viewer: VIEWER }, headers: RATE_HEADERS }]);
    const captured = captureStdout();
    try {
      expect(await run(["doctor", "--team", "ENG"])).toBe(EXIT.ok);
      captured.restore();
      expect(captured.text()).toContain("config,pass,team ENG,");
    } finally {
      captured.restore();
      stub.restore();
    }
  });

  test("run([doctor]) with malformed config prints every check then exits 1", async () => {
    const box = sandbox();
    boxes.push(box);
    delete process.env.LINEAR_API_KEY;
    const configDir = join(box.env["XDG_CONFIG_HOME"] as string, "lin");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.toml"), `color = "${SECRET}"\n`);
    const captured = captureStdout();
    try {
      await expect(run(["doctor"])).rejects.toMatchObject({
        exitCode: EXIT.api,
        message: "doctor found failing checks",
        hint: expect.stringContaining("api-key"),
      });
      captured.restore();
      const text = captured.text();
      expect(text.startsWith("checks[7]{check,status,detail,fix}:")).toBe(true);
      expect(text).toContain("api-key,fail,not set,");
      expect(text).toContain("linear,skip,no API key,");
      expect(text).toContain("rate,skip,no rate headers,");
      expect(text).toContain("config,fail,");
      expect(text).toContain("unknown key color");
      expect(text).toContain("cache,");
      expect(text).toContain("tui-native,skip,no embedded native library,");
      expect(text).toContain("fonts,");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("lin_api");
    } finally {
      captured.restore();
    }
  });

  test("other commands still fail closed on malformed config", async () => {
    const box = sandbox();
    boxes.push(box);
    const configDir = join(box.env["XDG_CONFIG_HOME"] as string, "lin");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.toml"), `color = "${SECRET}"\n`);
    const captured = captureStdout();
    try {
      await expect(run(["ls"])).rejects.toMatchObject({
        exitCode: EXIT.input,
        message: expect.stringContaining("unknown key color"),
      });
      captured.restore();
      expect(captured.text()).toBe("");
    } finally {
      captured.restore();
    }
  });

  test("only doctor skips pre-dispatch config resolution", () => {
    expect(getCommand("doctor")?.selfConfig).toBe(true);
    expect(getCommand("auth")?.selfConfig).toBeUndefined();
    expect(getCommand("ls")?.selfConfig).toBeUndefined();
  });
});
