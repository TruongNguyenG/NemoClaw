// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { CommandContext } from "../index.js";

export async function connect(ctx: CommandContext): Promise<void> {
  const { api, flags } = ctx;
  const sandboxName = flags["sandbox"] as string;

  api.log("info", `Connecting to OpenClaw sandbox: ${sandboxName}`);
  api.log("info", "You will be inside the sandbox. Run 'openclaw' commands normally.");
  api.log("info", "Type 'exit' to return to your host shell.");
  api.log("info", "");

  const exitCode = await new Promise<number | null>((resolve) => {
    const proc = spawn("openshell", ["sandbox", "connect", sandboxName], {
      stdio: "inherit",
    });
    proc.on("close", resolve);
    proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        api.log("error", "openshell CLI not found. Is OpenShell installed?");
      } else {
        api.log("error", `Connection failed: ${err.message}`);
      }
      resolve(1);
    });
  });

  if (exitCode !== 0 && exitCode !== null) {
    api.log("error", `Sandbox '${sandboxName}' exited with code ${String(exitCode)}.`);
    api.log("info", "Run 'openclaw openshell status' to check available sandboxes.");
  }
}
