// owned by: core agent
// Bounded first-run diagnostics. Prints every check, then fails closed.

import { resolveConfig } from "../config.ts";
import { DOCTOR_COLUMNS, runDoctor } from "../doctor.ts";
import { EXIT, LinError, table } from "../out.ts";
import { defineCommand, flagNumber, flagString } from "../registry.ts";

export default defineCommand({
  name: "doctor",
  group: "meta",
  summary: "run setup checks for API key, Linear, config, cache, and TUI",
  fields: [...DOCTOR_COLUMNS],
  examples: ["lin doctor"],
  selfConfig: true,
  async run({ flags }) {
    const team = flagString(flags, "team");
    const limit = flagNumber(flags, "limit");
    const result = await runDoctor({
      env: process.env,
      loadConfig: () => resolveConfig({ team, limit }),
    });
    table("checks", result.rows, DOCTOR_COLUMNS);
    if (!result.failedRequired) return;
    throw new LinError(
      EXIT.api,
      "doctor found failing checks",
      `failing: ${result.failing.join(", ")}`,
    );
  },
});
