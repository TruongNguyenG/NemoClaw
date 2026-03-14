// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, cpSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandContext, PluginAPI } from "../index.js";
import { resolveBlueprint } from "../blueprint/resolve.js";
import { verifyBlueprintDigest } from "../blueprint/verify.js";
import { execBlueprint } from "../blueprint/exec.js";
import { loadState, saveState } from "../blueprint/state.js";

const HOME = process.env.HOME ?? "/tmp";

export interface HostOpenClawState {
  exists: boolean;
  configDir: string | null;
  workspaceDir: string | null;
  extensionsDir: string | null;
  skillsDir: string | null;
  configFile: string | null;
}

export function detectHostOpenClaw(): HostOpenClawState {
  const configDir = join(HOME, ".openclaw");
  const exists = existsSync(configDir);

  if (!exists) {
    return {
      exists: false,
      configDir: null,
      workspaceDir: null,
      extensionsDir: null,
      skillsDir: null,
      configFile: null,
    };
  }

  const configFile = existsSync(join(configDir, "openclaw.json"))
    ? join(configDir, "openclaw.json")
    : null;

  const workspaceDir = existsSync(join(configDir, "workspace"))
    ? join(configDir, "workspace")
    : null;

  const extensionsDir = existsSync(join(configDir, "extensions"))
    ? join(configDir, "extensions")
    : null;

  const skillsDir = existsSync(join(configDir, "skills")) ? join(configDir, "skills") : null;

  return {
    exists: true,
    configDir,
    workspaceDir,
    extensionsDir,
    skillsDir,
    configFile,
  };
}

export async function migrate(ctx: CommandContext): Promise<void> {
  const { api, config, flags } = ctx;
  const dryRun = flags["dry-run"] as boolean;
  const profile = flags["profile"] as string;
  const skipBackup = flags["skip-backup"] as boolean;

  api.log("info", "OpenShell Plugin migrate: moving host OpenClaw into OpenShell sandbox");

  // Step 1: Detect host OpenClaw state
  api.progress("Detecting host OpenClaw installation", 5);
  const hostState = detectHostOpenClaw();

  if (!hostState.exists) {
    api.log("error", "No OpenClaw installation found at ~/.openclaw");
    api.log("info", "Use 'openclaw openshell launch' for a fresh install.");
    return;
  }

  api.log("info", `Found OpenClaw config at ${hostState.configDir ?? "~/.openclaw"}`);
  if (hostState.configFile) api.log("info", `  Config: ${hostState.configFile}`);
  if (hostState.workspaceDir) api.log("info", `  Workspace: ${hostState.workspaceDir}`);
  if (hostState.extensionsDir) api.log("info", `  Extensions: ${hostState.extensionsDir}`);
  if (hostState.skillsDir) api.log("info", `  Skills: ${hostState.skillsDir}`);

  // Step 2: Create snapshot backup
  let snapshotPath: string | null = null;
  if (!skipBackup) {
    api.progress("Creating host backup snapshot", 15);
    snapshotPath = createSnapshot(hostState, api);
    if (!snapshotPath) {
      api.log("error", "Failed to create backup snapshot. Use --skip-backup to proceed anyway.");
      return;
    }
    api.log("info", `Snapshot saved to ${snapshotPath}`);
  }

  if (dryRun) {
    api.log("info", "");
    api.log("info", "[Dry run] Would perform the following:");
    api.log("info", "  1. Resolve and verify blueprint");
    api.log("info", "  2. Create OpenShell sandbox");
    api.log("info", "  3. Copy config, workspace, extensions, and skills into sandbox");
    api.log("info", "  4. Patch paths for sandbox context");
    api.log("info", "  5. Configure inference provider");
    api.log("info", "  6. Cut over to sandbox runtime");
    api.log("info", "  7. Archive host ~/.openclaw");
    return;
  }

  // Step 3: Resolve and verify blueprint
  api.progress("Resolving blueprint", 25);
  const blueprint = await resolveBlueprint(config);

  api.progress("Verifying blueprint", 30);
  const verification = verifyBlueprintDigest(blueprint.localPath, blueprint.manifest);
  if (!verification.valid) {
    api.log("error", `Blueprint verification failed: ${verification.errors.join(", ")}`);
    return;
  }

  // Step 4: Plan migration
  api.progress("Planning migration", 40);
  const planResult = await execBlueprint(
    {
      blueprintPath: blueprint.localPath,
      action: "plan",
      profile,
      jsonOutput: true,
    },
    api,
  );

  if (!planResult.success) {
    api.log("error", `Migration plan failed: ${planResult.output}`);
    return;
  }

  // Step 5: Apply migration
  api.progress("Provisioning OpenShell sandbox", 55);
  api.progress("Restoring config into sandbox", 70);
  api.progress("Patching paths for sandbox context", 80);
  api.progress("Configuring inference provider", 85);

  const applyResult = await execBlueprint(
    {
      blueprintPath: blueprint.localPath,
      action: "apply",
      profile,
      planPath: planResult.runId,
      jsonOutput: true,
    },
    api,
  );

  if (!applyResult.success) {
    api.log("error", `Migration apply failed: ${applyResult.output}`);
    if (snapshotPath) {
      api.log("info", `Restore from snapshot: ${snapshotPath}`);
    }
    return;
  }

  // Step 6: Save state for eject
  saveState({
    ...loadState(),
    lastRunId: applyResult.runId,
    lastAction: "migrate",
    blueprintVersion: blueprint.version,
    sandboxName: config.sandboxName,
    migrationSnapshot: snapshotPath,
    hostBackupPath: snapshotPath,
  });

  api.progress("Migration complete", 100);
  api.log("info", "");
  api.log("info", "Migration complete. OpenClaw is now running inside OpenShell.");
  api.log("info", `Sandbox: ${config.sandboxName}`);
  api.log("info", "");
  api.log("info", "Next steps:");
  api.log("info", "  openclaw openshell connect    # Enter the sandbox");
  api.log("info", "  openclaw openshell status     # Verify everything is healthy");
  api.log("info", "  openshell term               # Monitor sandbox activity");
  api.log("info", "");
  api.log("info", "To rollback to your host installation:");
  api.log("info", "  openclaw openshell eject");
}

function createSnapshot(hostState: HostOpenClawState, api: PluginAPI): string | null {
  if (!hostState.configDir) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = join(HOME, ".openshell-plugin", "snapshots", timestamp);

  try {
    mkdirSync(snapshotDir, { recursive: true });
    cpSync(hostState.configDir, join(snapshotDir, "openclaw"), {
      recursive: true,
    });

    // Record what was captured
    const manifest = {
      timestamp,
      source: hostState.configDir,
      contents: readdirSync(join(snapshotDir, "openclaw")),
    };
    writeFileSync(join(snapshotDir, "snapshot.json"), JSON.stringify(manifest, null, 2));

    return snapshotDir;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    api.log("error", `Snapshot failed: ${msg}`);
    return null;
  }
}
