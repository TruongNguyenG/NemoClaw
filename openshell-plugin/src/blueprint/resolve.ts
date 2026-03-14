// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellPluginConfig } from "../index.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BlueprintManifest {
  version: string;
  minOpenShellVersion: string;
  minOpenClawVersion: string;
  profiles: string[];
  digest: string;
}

export interface ResolvedBlueprint {
  version: string;
  localPath: string;
  manifest: BlueprintManifest;
  cached: boolean;
}

const CACHE_DIR = join(process.env.HOME ?? "/tmp", ".openshell-plugin", "blueprints");

export function getCacheDir(): string {
  return CACHE_DIR;
}

export function getCachedBlueprintPath(version: string): string {
  return join(CACHE_DIR, version);
}

export function isCached(version: string): boolean {
  const manifestPath = join(getCachedBlueprintPath(version), "blueprint.yaml");
  return existsSync(manifestPath);
}

export function readCachedManifest(version: string): BlueprintManifest | null {
  const manifestPath = join(getCachedBlueprintPath(version), "blueprint.yaml");
  if (!existsSync(manifestPath)) return null;
  const raw = readFileSync(manifestPath, "utf-8");
  // Minimal YAML parsing for the manifest header
  return parseManifestHeader(raw);
}

function parseManifestHeader(raw: string): BlueprintManifest {
  const get = (key: string): string => {
    const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim() ?? "";
  };
  const profiles = get("profiles");
  return {
    version: get("version"),
    minOpenShellVersion: get("min_openshell_version"),
    minOpenClawVersion: get("min_openclaw_version"),
    profiles: profiles ? profiles.split(",").map((p) => p.trim()) : ["default"],
    digest: get("digest"),
  };
}

export async function resolveBlueprint(config: OpenShellPluginConfig): Promise<ResolvedBlueprint> {
  const version = config.blueprintVersion;

  // Check local cache first
  if (version !== "latest" && isCached(version)) {
    const manifest = readCachedManifest(version);
    if (manifest) {
      return {
        version,
        localPath: getCachedBlueprintPath(version),
        manifest,
        cached: true,
      };
    }
  }

  // Fetch from registry
  return fetchBlueprint(config.blueprintRegistry, version);
}

function fetchBlueprint(registry: string, version: string): Promise<ResolvedBlueprint> {
  // Not yet implemented. The intended flow is:
  // 1. Resolve "latest" to a concrete version tag via registry API
  // 2. Download the blueprint tarball from the OCI registry
  // 3. Verify digest (SHA-256) against the registry manifest
  // 4. Check compatibility metadata (min OpenShell/OpenClaw versions)
  // 5. Extract to local cache dir
  // 6. Return resolved blueprint
  //
  // For now, blueprints must be placed manually in the cache directory.
  return Promise.reject(
    new Error(
      `Blueprint fetch not yet implemented. ` +
        `Registry: ${registry}, Version: ${version}. ` +
        `Place blueprint files in ${getCacheDir()}/<version>/ for local development.`,
    ),
  );
}
