export type JsonObject = Record<string, unknown>;
export type CustomAgent = JsonObject & { id?: unknown; command?: unknown; env?: unknown };

export const ACP_PLUGIN_ID = "provider-acp";

export const PROFILE = {
  id: "kimi",
  providerId: "acp-kimi",
  displayName: "Kimi",
  binary: "kimi",
  args: ["acp"],
  // Skill directories Kimi Code CLI discovers on its own
  // (`moonshotai.github.io/kimi-code/en/customization/skills`): user roots
  // resolve from the home directory (`$KIMI_CODE_HOME` defaults to
  // `~/.kimi-code`), project roots from the project root. `.agents/skills`
  // is the cross-vendor directory Kimi reads at both levels.
  nativeSkillRoots: {
    user: [".kimi-code/skills", ".agents/skills"],
    project: [".kimi-code/skills", ".agents/skills"],
  },
  // bb's permission modes as Kimi launch flags (`kimi` command reference).
  // bb's default "auto" mode adds no flag, so Kimi starts in its default
  // `manual` permission mode and every tool call comes through ACP for
  // approval. Accept-edits maps to `--yolo` (Ask When Needed: routine edits
  // and commands run, risky actions and plans still ask) — Kimi has no
  // edits-only launch flag; finer control lives in `[[permission.rules]]`
  // in ~/.kimi-code/config.toml. Full access maps to `--auto` (Never Ask).
  permissionCli: {
    workspaceWrite: ["--yolo"],
    full: ["--auto"],
  },
  // Kimi Code CLI ships `/compact`, so bb may show the manual compaction
  // affordance for this provider.
  supportsManualCompaction: true,
  installHint:
    "Install Kimi Code CLI with `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash` (or `npm install -g @moonshot-ai/kimi-code`), authenticate once with `kimi login` (or `/login` inside `kimi`), then run `bb plugin reload kimi`.",
} as const;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOwnAgent(agent: CustomAgent | undefined): boolean {
  return agent?.id === PROFILE.id;
}

export function findOwnAgent(agents: CustomAgent[]): CustomAgent | undefined {
  return agents.find(isOwnAgent);
}

export function parseCustomAgents(value: unknown): CustomAgent[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new Error(`${ACP_PLUGIN_ID} customAgents must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(`${ACP_PLUGIN_ID} customAgents must be a JSON array; refusing to overwrite it`);
  }
  return parsed as CustomAgent[];
}

export function stringifyCustomAgents(agents: CustomAgent[]): string {
  return `${JSON.stringify(agents, null, 2)}\n`;
}

export function managedAgent(binary: string, existing?: CustomAgent): CustomAgent {
  const existingEnv = isObject(existing?.env) ? existing.env : {};
  return {
    // Keys the user added themselves (cwd, dialect, modelCli, ...) survive a
    // reload; the fields below are ours and are rewritten every time.
    ...(existing ?? {}),
    id: PROFILE.id,
    displayName: PROFILE.displayName,
    command: binary,
    args: [...PROFILE.args],
    env: existingEnv,
    nativeSkillRoots: {
      user: [...PROFILE.nativeSkillRoots.user],
      project: [...PROFILE.nativeSkillRoots.project],
    },
    permissionCli: {
      workspaceWrite: [...PROFILE.permissionCli.workspaceWrite],
      full: [...PROFILE.permissionCli.full],
    },
    supportsManualCompaction: PROFILE.supportsManualCompaction,
  };
}

export function upsertAgent(agents: CustomAgent[], next: CustomAgent): { agents: CustomAgent[]; changed: boolean } {
  const index = agents.findIndex(isOwnAgent);
  const before = JSON.stringify(index >= 0 ? agents[index] : null);
  const copy = [...agents];
  if (index >= 0) copy[index] = next;
  else copy.push(next);
  return { agents: copy, changed: JSON.stringify(index >= 0 ? copy[index] : copy.at(-1)) !== before };
}

export function removeAgent(agents: CustomAgent[]): { agents: CustomAgent[]; changed: boolean } {
  const next = agents.filter((agent) => !isOwnAgent(agent));
  return { agents: next, changed: next.length !== agents.length };
}
