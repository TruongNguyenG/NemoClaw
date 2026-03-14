// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import type { CommandContext } from "../index.js";
import { loadState } from "../blueprint/state.js";

export async function status(ctx: CommandContext): Promise<void> {
  const { api, flags } = ctx;
  const jsonOutput = flags["json"] as boolean;
  const state = loadState();
  const sandboxName = state.sandboxName ?? "openclaw";

  const [sandbox, inference] = await Promise.all([
    getSandboxStatus(sandboxName),
    getInferenceStatus(),
  ]);

  const statusData = {
    openshellPlugin: {
      lastAction: state.lastAction,
      lastRunId: state.lastRunId,
      blueprintVersion: state.blueprintVersion,
      sandboxName: state.sandboxName,
      migrationSnapshot: state.migrationSnapshot,
      updatedAt: state.updatedAt,
    },
    sandbox,
    inference,
  };

  if (jsonOutput) {
    api.log("info", JSON.stringify(statusData, null, 2));
    return;
  }

  api.log("info", "OpenShell Plugin Status");
  api.log("info", "======================");
  api.log("info", "");

  api.log("info", "Plugin State:");
  if (state.lastAction) {
    api.log("info", `  Last action:      ${state.lastAction}`);
    api.log("info", `  Blueprint:        ${state.blueprintVersion ?? "unknown"}`);
    api.log("info", `  Run ID:           ${state.lastRunId ?? "none"}`);
    api.log("info", `  Updated:          ${state.updatedAt}`);
  } else {
    api.log("info", "  No operations have been performed yet.");
  }
  api.log("info", "");

  api.log("info", "Sandbox:");
  if (sandbox.running) {
    api.log("info", `  Name:    ${sandbox.name}`);
    api.log("info", "  Status:  running");
    api.log("info", `  Uptime:  ${sandbox.uptime ?? "unknown"}`);
  } else {
    api.log("info", "  Status:  not running");
  }
  api.log("info", "");

  api.log("info", "Inference:");
  if (inference.configured) {
    api.log("info", `  Provider:  ${inference.provider ?? "unknown"}`);
    api.log("info", `  Model:     ${inference.model ?? "unknown"}`);
    api.log("info", `  Endpoint:  ${inference.endpoint ?? "unknown"}`);
  } else {
    api.log("info", "  Not configured");
  }

  if (state.migrationSnapshot) {
    api.log("info", "");
    api.log("info", "Rollback:");
    api.log("info", `  Snapshot:  ${state.migrationSnapshot}`);
    api.log("info", "  Run 'openclaw openshell eject' to restore host installation.");
  }
}

interface SandboxStatus {
  name: string;
  running: boolean;
  uptime: string | null;
}

interface SandboxStatusResponse {
  state?: string;
  uptime?: string;
}

async function getSandboxStatus(sandboxName: string): Promise<SandboxStatus> {
  try {
    const { stdout } = await execAsync(`openshell sandbox status ${sandboxName} --json`, {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout) as SandboxStatusResponse;
    return {
      name: sandboxName,
      running: parsed.state === "running",
      uptime: parsed.uptime ?? null,
    };
  } catch {
    return { name: sandboxName, running: false, uptime: null };
  }
}

interface InferenceStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  endpoint: string | null;
}

interface InferenceStatusResponse {
  provider?: string;
  model?: string;
  endpoint?: string;
}

async function getInferenceStatus(): Promise<InferenceStatus> {
  try {
    const { stdout } = await execAsync("openshell inference get --json", {
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout) as InferenceStatusResponse;
    return {
      configured: true,
      provider: parsed.provider ?? null,
      model: parsed.model ?? null,
      endpoint: parsed.endpoint ?? null,
    };
  } catch {
    return { configured: false, provider: null, model: null, endpoint: null };
  }
}
