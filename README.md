# bb-plugin-kimi

Adds Moonshot AI's [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) to
[bb](https://getbb.app) as an ACP coding-agent provider.

After installation, **Kimi** appears in bb as provider **`acp-kimi`**, next to
Claude Code, Codex, OpenCode and the rest. Threads run on your own Kimi Code
login (subscription or API key), billed by Moonshot, not bb.

## Prerequisites

- bb 0.40 or newer with its built-in ACP providers plugin enabled.
- Kimi Code CLI:

  ```bash
  curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
  kimi login        # device-code OAuth, same as /login inside the TUI
  ```

  (`npm install -g @moonshot-ai/kimi-code` works too; on Windows install Git
  for Windows first — Kimi uses its Git Bash as the shell environment.)

## Install

Until the marketplace entry is merged, install directly from GitHub:

```bash
bb plugin install git:https://github.com/OWNER/bb-plugin-kimi.git@main
```

For local development:

```bash
npm install
npm run typecheck
npm test
npm run build        # requires the bb CLI: bb plugin build .
bb plugin install .
```

The plugin locates the `kimi` binary (PATH, `~/.kimi-code/bin`, the usual
npm/homebrew bins) and writes or repairs its managed entry in the ACP
providers plugin's `customAgents` setting without disturbing other agents.
It uses `kimi acp` over stdio. The model catalog (`kimi-code/k3`,
`kimi-code/kimi-for-coding`, `kimi-code/kimi-for-coding-highspeed`, …),
thinking effort, session modes and authentication methods all come from
Kimi's ACP session catalog — nothing is hard-coded.

## What you get over ACP

Kimi Code CLI implements the full ACP core + session surface, so inside bb you
get: streamed timeline with tool calls and plans, permission prompts on bb's
native approval cards, ask-user questions through bb's form, model/effort
pickers (`session/set_config_option`), session resume (`session/load`),
image prompts, and manual `/compact` (the entry declares
`supportsManualCompaction`).

## Skills

The managed entry declares the skill directories Kimi Code CLI discovers, so
bb lists them in the composer next to its own:

- project: `.kimi-code/skills/`, `.agents/skills/`
- user: `~/.kimi-code/skills/`, `~/.agents/skills/`

## Permission modes

bb's thread permission mode becomes a Kimi launch flag:

| bb mode      | Kimi flags | Behaviour |
| ------------ | ---------- | --------- |
| Auto         | none       | Kimi's default `manual` mode — every tool call comes through ACP for approval |
| Accept edits | `--yolo`   | Ask When Needed — routine edits and commands run unattended; risky actions, questions and plans still ask |
| Full access  | `--auto`   | Never Ask — everything runs and is decided automatically |

`--yolo` is the closest honest equivalent of Accept edits: Kimi has no
edits-only launch flag (it also auto-runs routine shell commands). For finer
control use `[[permission.rules]]` in `~/.kimi-code/config.toml` — those rules
stack with the mode selected in bb.

## Check or repair

```bash
bb kimi status
bb kimi repair
bb provider models acp-kimi
```

If the CLI moves after an upgrade, `bb kimi repair` records its new absolute
path and reloads bb.

## Uninstall

Remove the managed provider entry before removing the plugin:

```bash
bb kimi unregister
bb plugin remove kimi
```

## How it works

bb's built-in ACP provider supplies the ACP-to-bb runtime. This plugin manages
the provider-specific launch profile in that plugin's `customAgents` setting
(the old `customAcpAgents` array in `config.json` is deprecated in bb 0.40 and
removed in 0.41; the plugin migrates and strips such an entry). Authentication
and model availability remain owned by the Kimi CLI and the user's account.

The package ID is `kimi`; the provider ID is `acp-kimi`. The compact icon is an
original crescent-and-star mark drawn as a `currentColor` mask so it follows
the bb theme.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The plugin requires bb 0.40+ and plugin SDK 0.4.8+. Server code is adapted
from [bb-auggie](https://github.com/ai-ecoverse/bb-auggie) (MIT), the reference
implementation of this integration pattern.
