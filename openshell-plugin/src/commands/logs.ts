// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { CommandContext } from "../index.js";
import { loadState } from "../blueprint/state.js";

export async function logs(ctx: CommandContext): Promise<void> {
  const { api, flags } = ctx;
  const follow = flags["follow"] as boolean;
  const component = flags["component"] as string | undefined;
  const state = loadState();
  const sandboxName = state.sandboxName ?? "openclaw";

  const logSources: { name: string; command: string[] }[] = [];

  if (!component || component === "sandbox") {
    logSources.push({
      name: "sandbox",
      command: ["openshell", "sandbox", "logs", sandboxName, ...(follow ? ["--follow"] : [])],
    });
  }

  if (!component || component === "blueprint") {
    if (state.lastRunId) {
      logSources.push({
        name: "blueprint",
        command: [
          "cat",
          `${process.env.HOME ?? "/tmp"}/.openshell-plugin/state/runs/${state.lastRunId}/output.log`,
        ],
      });
    }
  }

  if (!component || component === "inference") {
    logSources.push({
      name: "inference",
      command: ["openshell", "inference", "logs", ...(follow ? ["--follow"] : [])],
    });
  }

  if (logSources.length === 0) {
    api.log("info", "No log sources available.");
    api.log("info", "Valid components: sandbox, blueprint, inference");
    return;
  }

  for (const source of logSources) {
    if (logSources.length > 1) {
      api.log("info", `--- ${source.name} ---`);
    }

    try {
      const proc = spawn(source.command[0], source.command.slice(1), {
        stdio: "inherit",
      });

      await new Promise<void>((resolve) => {
        proc.on("close", () => {
          resolve();
        });
        proc.on("error", () => {
          resolve();
        });
      });
    } catch {
      api.log("warn", `Could not read ${source.name} logs`);
    }
  }
}
