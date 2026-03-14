// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execSync } from "node:child_process";
import type { CommandContext } from "../index.js";
import { resolveBlueprint } from "../blueprint/resolve.js";
import { verifyBlueprintDigest, checkCompatibility } from "../blueprint/verify.js";
import { execBlueprint } from "../blueprint/exec.js";
import { loadState, saveState } from "../blueprint/state.js";
import { detectHostOpenClaw } from "./migrate.js";

export async function launch(ctx: CommandContext): Promise<void> {
  const { api, config, flags } = ctx;
  const force = flags["force"] as boolean;
  const profile = flags["profile"] as string;

  api.log("info", "OpenShell Plugin launch: setting up OpenClaw inside OpenShell");

  // Check if there's an existing host OpenClaw installation
  const hostState = detectHostOpenClaw();

  if (!hostState.exists && !force) {
    api.log("info", "");
    api.log("info", "No existing OpenClaw installation detected on this host.");
    api.log("info", "");
    api.log("info", "For net-new users, the recommended path is OpenShell-native setup:");
    api.log("info", "");
    api.log("info", "  openshell sandbox create --from openclaw --name openclaw");
    api.log("info", "  openshell sandbox connect openclaw");
    api.log("info", "");
    api.log(
      "info",
      "This avoids installing OpenClaw on the host only to redeploy it inside OpenShell.",
    );
    api.log("info", "");
    api.log("info", "To proceed with plugin-driven bootstrap anyway, use --force.");
    return;
  }

  if (hostState.exists && !force) {
    api.log(
      "info",
      "Existing OpenClaw installation detected. Consider using 'openclaw openshell migrate' instead.",
    );
    api.log(
      "info",
      "Use --force to proceed with a fresh launch (existing config will not be migrated).",
    );
    return;
  }

  // Resolve and verify blueprint
  api.progress("Resolving blueprint", 10);
  const blueprint = await resolveBlueprint(config);

  api.progress("Verifying blueprint integrity", 20);
  const verification = verifyBlueprintDigest(blueprint.localPath, blueprint.manifest);
  if (!verification.valid) {
    api.log("error", `Blueprint verification failed: ${verification.errors.join(", ")}`);
    return;
  }

  // Check version compatibility
  const openshellVersion = getOpenshellVersion();
  const openclawVersion = getOpenclawVersion();
  const compat = checkCompatibility(blueprint.manifest, openshellVersion, openclawVersion);
  if (compat.length > 0) {
    api.log("error", `Compatibility check failed:\n  ${compat.join("\n  ")}`);
    return;
  }

  // Plan
  api.progress("Planning deployment", 30);
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
    api.log("error", `Blueprint plan failed: ${planResult.output}`);
    return;
  }

  // Apply
  api.progress("Deploying OpenClaw sandbox", 50);
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
    api.log("error", `Blueprint apply failed: ${applyResult.output}`);
    return;
  }

  // Save state
  saveState({
    ...loadState(),
    lastRunId: applyResult.runId,
    lastAction: "launch",
    blueprintVersion: blueprint.version,
    sandboxName: config.sandboxName,
  });

  api.progress("Launch complete", 100);
  api.log("info", "");
  api.log("info", "OpenClaw is now running inside OpenShell.");
  api.log("info", `Sandbox: ${config.sandboxName}`);
  api.log("info", "");
  api.log("info", "Next steps:");
  api.log("info", "  openclaw openshell connect    # Enter the sandbox");
  api.log("info", "  openclaw openshell status     # Check health");
  api.log("info", "  openshell term               # Monitor network egress");
}

function getOpenshellVersion(): string {
  try {
    return execSync("openshell --version", { encoding: "utf-8" }).trim();
  } catch {
    return "0.0.0";
  }
}

function getOpenclawVersion(): string {
  try {
    return execSync("openclaw --version", { encoding: "utf-8" }).trim();
  } catch {
    return "0.0.0";
  }
}
