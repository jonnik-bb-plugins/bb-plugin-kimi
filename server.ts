// Adapted from bb-auggie (https://github.com/ai-ecoverse/bb-auggie), MIT license.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import {
  ACP_PLUGIN_ID,
  PROFILE,
  findOwnAgent,
  isObject,
  isOwnAgent,
  managedAgent,
  parseCustomAgents,
  removeAgent,
  stringifyCustomAgents,
  upsertAgent,
  type CustomAgent,
  type JsonObject,
} from "./src/agent-entry.js";

const SETTINGS_READY_ATTEMPTS = 10;
const SETTINGS_READY_DELAY_MS = 500;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(existing?: CustomAgent): string | null {
  // A previously recorded absolute path wins, so a user-pinned wrapper
  // survives reboots and a same-named binary elsewhere is never picked.
  if (typeof existing?.command === "string" && isAbsolute(existing.command) && isExecutable(existing.command)) {
    return existing.command;
  }
  const names = process.platform === "win32"
    ? [`${PROFILE.binary}.exe`, `${PROFILE.binary}.cmd`, PROFILE.binary]
    : [PROFILE.binary];
  const directories = [
    // The native install script and self-upgrades place the binary here
    // (it is also Kimi's documented default remoteBin for SSH targets).
    // Probed before PATH so the legacy Python `kimi-cli` never shadows it.
    join(homedir(), ".kimi-code", "bin"),
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);
  for (const directory of new Set(directories)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function readConfig(configPath: string): JsonObject {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isObject(parsed)) {
    throw new Error(`${configPath} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed;
}

function writeAtomic(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${PROFILE.id}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readLegacyAgents(dataDir: string): CustomAgent[] {
  const config = readConfig(join(dataDir, "config.json"));
  return Array.isArray(config.customAcpAgents) ? [...config.customAcpAgents] as CustomAgent[] : [];
}

// The legacy `customAcpAgents` array in config.json was removed in bb 0.41.
// It is only ever written here to *remove* a leftover entry of ours, never
// to register one.
function writeLegacyAgents(dataDir: string, agents: CustomAgent[]): boolean {
  const configPath = join(dataDir, "config.json");
  const config = readConfig(configPath);
  const current = Array.isArray(config.customAcpAgents) ? config.customAcpAgents as CustomAgent[] : [];
  if (JSON.stringify(current) === JSON.stringify(agents)) return false;
  if (agents.length === 0) delete config.customAcpAgents;
  else config.customAcpAgents = agents;
  writeAtomic(configPath, config);
  return true;
}

export default function plugin(bb: BbPluginApi) {
  async function dataDir(): Promise<string> {
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) return config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not resolve bb data directory through the SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }

  // Returns null when the ACP plugin's settings cannot be read yet (the
  // startup 404 race). A malformed `customAgents` value is *not* transient:
  // parseCustomAgents throws and the error surfaces to the caller instead of
  // being retried or silently routed to the removed legacy config path.
  async function readSettingAgents(): Promise<CustomAgent[] | null> {
    let values: Record<string, unknown>;
    try {
      const settings = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
      values = settings.values;
    } catch (error) {
      bb.log.warn(`Could not read ${ACP_PLUGIN_ID} customAgents: ${String(error)}`);
      return null;
    }
    return parseCustomAgents(values.customAgents);
  }

  // At startup the settings read can lose the race with the ACP plugin's own
  // factory and answer 404. Wait for the plugin to come up before deciding
  // the settings store is unavailable.
  async function readSettingAgentsWhenReady(): Promise<CustomAgent[] | null> {
    for (let attempt = 0; attempt < SETTINGS_READY_ATTEMPTS; attempt += 1) {
      const agents = await readSettingAgents();
      if (agents !== null) return agents;
      await new Promise((resolve) => setTimeout(resolve, SETTINGS_READY_DELAY_MS));
    }
    return readSettingAgents();
  }

  async function writeSettingAgents(agents: CustomAgent[]): Promise<void> {
    const serialized = agents.length === 0 ? "" : stringifyCustomAgents(agents);
    await bb.sdk.plugins.updateSettings({
      pluginId: ACP_PLUGIN_ID,
      values: { customAgents: serialized },
    });
  }

  // `customAgents` is one string shared by every ACP provider plugin (auggie,
  // copilot, ...), and each rewrites it whole. Re-read after writing so a
  // concurrent provisioner clobbering our entry is caught, not lost silently.
  async function writeSettingAgentsVerified(agents: CustomAgent[]): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await writeSettingAgents(agents);
      const reread = await readSettingAgents();
      if (reread !== null && findOwnAgent(reread) !== undefined) return;
      bb.log.warn(`${ACP_PLUGIN_ID} customAgents lost the ${PROFILE.id} entry after write; retrying`);
    }
    throw new Error(`Could not confirm the ${PROFILE.id} entry in ${ACP_PLUGIN_ID} customAgents after writing`);
  }

  async function provision(waitForSettings = false): Promise<{ changed: boolean; binary: string }> {
    const root = await dataDir();
    const settingAgents = waitForSettings ? await readSettingAgentsWhenReady() : await readSettingAgents();
    if (settingAgents === null) {
      throw new Error(
        `${ACP_PLUGIN_ID} settings are unavailable. Enable bb's built-in ACP providers plugin, then run \`bb ${PROFILE.id} repair\`.`,
      );
    }
    const legacyAgents = readLegacyAgents(root);
    const existing = findOwnAgent(settingAgents) ?? findOwnAgent(legacyAgents);
    const binary = findBinary(existing);
    if (binary === null) throw new Error(`${PROFILE.binary} was not found. ${PROFILE.installHint}`);

    const managed = managedAgent(binary, existing);
    let changed = false;

    const next = upsertAgent(settingAgents, managed);
    if (next.changed) {
      await writeSettingAgentsVerified(next.agents);
      changed = true;
    }

    const stripped = removeAgent(legacyAgents);
    if (stripped.changed && writeLegacyAgents(root, stripped.agents)) {
      await bb.sdk.system.reloadConfig();
      changed = true;
    }
    return { changed, binary };
  }

  async function unregister(): Promise<boolean> {
    const root = await dataDir();
    let changed = false;
    const settingAgents = await readSettingAgents();
    if (settingAgents !== null) {
      const next = removeAgent(settingAgents);
      if (next.changed) {
        await writeSettingAgents(next.agents);
        changed = true;
      }
    }
    const stripped = removeAgent(readLegacyAgents(root));
    if (stripped.changed && writeLegacyAgents(root, stripped.agents)) {
      await bb.sdk.system.reloadConfig();
      changed = true;
    }
    return changed;
  }

  bb.background.service("provision", {
    async start() {
      try {
        const result = await provision(true);
        bb.log.info(
          result.changed
            ? `registered ${PROFILE.providerId} with ${result.binary}`
            : `${PROFILE.providerId} is already configured`,
        );
      } catch (error) {
        const message = String(error);
        bb.log.error(message);
        bb.status.needsConfiguration(message);
      }
    },
  });

  bb.cli.register({
    name: PROFILE.id,
    summary: `Manage the ${PROFILE.displayName} ACP provider.`,
    commands: [
      { name: "status", summary: "Check the CLI and bb provider registration", usage: `${PROFILE.id} status` },
      { name: "repair", summary: "Rewrite and reload the managed ACP configuration", usage: `${PROFILE.id} repair` },
      { name: "unregister", summary: "Remove this plugin's managed ACP configuration", usage: `${PROFILE.id} unregister` },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "repair") {
        try {
          const result = await provision();
          return {
            exitCode: 0,
            stdout: `${PROFILE.providerId}: ${result.changed ? "repaired" : "already up to date"}\nCLI: ${result.binary}\nRun \`bb plugin reload ${PROFILE.id}\` to clear a boot-time needs-configuration status.\n`,
          };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
      }
      if (command === "unregister") {
        try {
          const changed = await unregister();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${changed ? "unregistered" : "not configured"}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
      }
      if (command === "status") {
        const root = await dataDir();
        let settingAgents: CustomAgent[] | null = null;
        let settingError: string | null = null;
        try {
          settingAgents = await readSettingAgents();
        } catch (error) {
          settingError = String(error);
        }
        let legacyAgents: CustomAgent[] = [];
        let legacyError = false;
        try {
          legacyAgents = readLegacyAgents(root);
        } catch {
          legacyError = true;
        }
        const entry = (settingAgents === null ? undefined : findOwnAgent(settingAgents))
          ?? findOwnAgent(legacyAgents);
        const binary = findBinary(entry);
        let registered: boolean | "unknown" = "unknown";
        try {
          registered = (await bb.sdk.providers.list()).some((provider) => provider.id === PROFILE.providerId);
        } catch (error) {
          bb.log.warn(`Could not list providers: ${String(error)}`);
        }
        const setting = settingError !== null
          ? `unreadable (${settingError})`
          : settingAgents === null
            ? "unavailable"
            : settingAgents.some(isOwnAgent)
              ? "present"
              : "missing";
        const legacy = legacyError ? "unreadable" : legacyAgents.some(isOwnAgent) ? "present" : "absent";
        return {
          exitCode: binary && entry && registered === true ? 0 : 1,
          stdout: [
            `CLI: ${binary ?? "NOT FOUND"}`,
            `ACP customAgents entry: ${setting}`,
            `legacy config.json entry: ${legacy}`,
            `bb provider ${PROFILE.providerId}: ${registered === "unknown" ? "unknown" : registered ? "registered" : "NOT registered"}`,
          ].join("\n") + "\n",
        };
      }
      return { exitCode: 2, stderr: `Unknown subcommand "${command}". Use "bb ${PROFILE.id} status".\n` };
    },
  });
}
