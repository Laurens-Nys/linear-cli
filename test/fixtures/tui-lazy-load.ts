import { run } from "../../src/main.ts";

const runModule = require.resolve("../../src/tui/run.ts");
const coreModule = require.resolve("@opentui/core");
const before = {
  run: require.cache[runModule] !== undefined,
  core: require.cache[coreModule] !== undefined,
};

let exitCode: number | undefined;
try {
  await run(["tui"]);
} catch (error) {
  exitCode = error && typeof error === "object" && "exitCode" in error
    ? Number(error.exitCode)
    : undefined;
}

const after = {
  run: require.cache[runModule] !== undefined,
  core: require.cache[coreModule] !== undefined,
};

console.log(JSON.stringify({ before, after, exitCode }));
