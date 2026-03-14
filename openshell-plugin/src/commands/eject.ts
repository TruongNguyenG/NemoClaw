// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, cpSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext } from "../index.js";
import { execBlueprint } from "../blueprint/exec.js";
import { loadState, clearState } from "../blueprint/state.js";

const HOME = process.env.HOME ?? "/tmp";

export async function eject(ctx: CommandContext): Promise<void> {
  const { api, flags } = ctx;
  const confirm = flags["confirm"] as boolean;
  const runId = flags["run-id"] as string | undefined;
  const state = loadState();

  if (!state.lastAction) {
    api.log("error", "No OpenShell Plugin deployment found. Nothing to eject from.");
    return;
  }

  if (!state.migrationSnapshot && !state.hostBackupPath) {
    api.log("error", "No migration snapshot found. Cannot restore host installation.");
    api.log("info", "If you used --skip-backup during migrate, manual restoration is required.");
    return;
  }

  const snapshotPath = state.migrationSnapshot ?? state.hostBackupPath;
  if (!snapshotPath) {
    api.log("error", "No snapshot or backup path found in state. Cannot restore.");
    return;
  }
  const snapshotOpenClawDir = join(snapshotPath, "openclaw");

  if (!existsSync(snapshotOpenClawDir)) {
    api.log("error", `Snapshot directory not found: ${snapshotOpenClawDir}`);
    return;
  }

  if (!confirm) {
    api.log("info", "Eject will:");
    api.log("info", "  1. Stop the OpenShell sandbox");
    api.log("info", "  2. Rollback blueprint state");
    api.log("info", `  3. Restore ~/.openclaw from snapshot: ${snapshotPath}`);
    api.log("info", "  4. Clear OpenShell Plugin state");
    api.log("info", "");
    api.log("info", "Run with --confirm to proceed, or cancel now.");
    return;
  }

  // Step 1: Rollback blueprint
  if (state.lastRunId && state.blueprintVersion) {
    api.progress("Rolling back blueprint", 20);
    const blueprintPath = join(HOME, ".openshell-plugin", "blueprints", state.blueprintVersion);

    if (existsSync(blueprintPath)) {
      const rollbackResult = await execBlueprint(
        {
          blueprintPath,
          action: "rollback",
          profile: "default",
          runId: runId ?? state.lastRunId,
          jsonOutput: true,
        },
        api,
      );

      if (!rollbackResult.success) {
        api.log("warn", `Blueprint rollback returned errors: ${rollbackResult.output}`);
        api.log("info", "Continuing with host restoration...");
      }
    }
  }

  // Step 2: Restore host ~/.openclaw from snapshot
  api.progress("Restoring host OpenClaw", 60);
  const currentConfigDir = join(HOME, ".openclaw");

  try {
    // Archive current sandbox-managed config
    if (existsSync(currentConfigDir)) {
      const archiveName = `${currentConfigDir}.openshell-plugin-archived-${String(Date.now())}`;
      renameSync(currentConfigDir, archiveName);
      api.log("info", `Archived current config to ${archiveName}`);
    }

    // Restore from snapshot
    mkdirSync(currentConfigDir, { recursive: true });
    cpSync(snapshotOpenClawDir, currentConfigDir, { recursive: true });
    api.log("info", "Host OpenClaw configuration restored.");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    api.log("error", `Restoration failed: ${msg}`);
    api.log("info", `Manual restore available at: ${snapshotOpenClawDir}`);
    return;
  }

  // Step 3: Clear OpenShell Plugin state
  api.progress("Cleaning up OpenShell Plugin state", 90);
  clearState();

  api.progress("Eject complete", 100);
  api.log("info", "");
  api.log("info", "Eject complete. Host OpenClaw installation has been restored.");
  api.log("info", "You can now run 'openclaw' directly on your host.");
}
