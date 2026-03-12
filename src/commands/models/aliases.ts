import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { loadModelsConfig } from "./load-config.js";
import {
  ensureFlagCompatibility,
  normalizeAlias,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsAliasesListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({ commandName: "models aliases list", runtime });
  const models = cfg.agents?.defaults?.models ?? {};
  const aliases = Object.entries(models).reduce<Record<string, string>>(
    (acc, [modelKey, entry]) => {
      const rawAlias = entry?.alias;
      const aliasList = Array.isArray(rawAlias)
        ? rawAlias.map((a) => String(a ?? "").trim()).filter(Boolean)
        : [String(rawAlias ?? "").trim()].filter(Boolean);
      for (const alias of aliasList) {
        acc[alias] = modelKey;
      }
      return acc;
    },
    {},
  );

  if (opts.json) {
    runtime.log(JSON.stringify({ aliases }, null, 2));
    return;
  }
  if (opts.plain) {
    for (const [alias, target] of Object.entries(aliases)) {
      runtime.log(`${alias} ${target}`);
    }
    return;
  }

  runtime.log(`Aliases (${Object.keys(aliases).length}):`);
  if (Object.keys(aliases).length === 0) {
    runtime.log("- none");
    return;
  }
  for (const [alias, target] of Object.entries(aliases)) {
    runtime.log(`- ${alias} -> ${target}`);
  }
}

export async function modelsAliasesAddCommand(
  aliasRaw: string,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const alias = normalizeAlias(aliasRaw);
  const cfg = await loadModelsConfig({ commandName: "models aliases add", runtime });
  const resolved = resolveModelTarget({ raw: modelRaw, cfg });
  const _updated = await updateConfig((cfg) => {
    const modelKey = `${resolved.provider}/${resolved.model}`;
    const nextModels = { ...cfg.agents?.defaults?.models };
    for (const [key, entry] of Object.entries(nextModels)) {
      const rawExisting = entry?.alias;
      const existingList = Array.isArray(rawExisting)
        ? rawExisting.map((a) => String(a ?? "").trim())
        : [String(rawExisting ?? "").trim()];
      if (existingList.includes(alias) && key !== modelKey) {
        throw new Error(`Alias ${alias} already points to ${key}.`);
      }
    }
    const existing = nextModels[modelKey] ?? {};
    // Append to existing aliases if any
    const currentAliases = Array.isArray(existing.alias)
      ? existing.alias.map((a: string) => String(a ?? "").trim()).filter(Boolean)
      : existing.alias?.trim()
        ? [existing.alias.trim()]
        : [];
    if (!currentAliases.includes(alias)) {
      currentAliases.push(alias);
    }
    nextModels[modelKey] = {
      ...existing,
      alias: currentAliases.length === 1 ? currentAliases[0] : currentAliases,
    };
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Alias ${alias} -> ${resolved.provider}/${resolved.model}`);
}

export async function modelsAliasesRemoveCommand(aliasRaw: string, runtime: RuntimeEnv) {
  const alias = normalizeAlias(aliasRaw);
  const updated = await updateConfig((cfg) => {
    const nextModels = { ...cfg.agents?.defaults?.models };
    let found = false;
    for (const [key, entry] of Object.entries(nextModels)) {
      const rawExisting = entry?.alias;
      const existingList = Array.isArray(rawExisting)
        ? rawExisting.map((a) => String(a ?? "").trim())
        : [String(rawExisting ?? "").trim()];
      if (existingList.includes(alias)) {
        const remaining = existingList.filter((a) => a !== alias);
        nextModels[key] = {
          ...entry,
          alias:
            remaining.length === 0 ? undefined : remaining.length === 1 ? remaining[0] : remaining,
        };
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`Alias not found: ${alias}`);
    }
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  if (
    !updated.agents?.defaults?.models ||
    Object.values(updated.agents.defaults.models).every((entry) => {
      const a = entry?.alias;
      return Array.isArray(a) ? a.length === 0 : !a?.trim();
    })
  ) {
    runtime.log("No aliases configured.");
  }
}
