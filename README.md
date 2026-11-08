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
bb plugin install git:https://github.com/jonnik-bb-plugins/bb-plugin-kimi.git@main
```

For local development:

```bash
npm install
npm run typecheck
npm test
npm run build        # requires the bb CLI: bb plugin build .
bb plugin install .
```

The plugin locates the `kimi` binary (`~/.kimi-code/bin` first, then PATH and
the usual npm/homebrew bins) and writes or repairs its managed entry in the
ACP providers plugin's `customAgents` setting without disturbing other
agents. It uses `kimi acp` over stdio. The model catalog, thinking effort,
session modes and authentication methods all come from Kimi's ACP session
catalog — nothing is hard-coded.

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

Kimi Code CLI takes **no permission launch flags in ACP mode**: `kimi acp`
starts every session in Kimi's default manual mode regardless of `--yolo` /
`--auto` on the command line (verified against Kimi Code CLI 2.5.2: the ACP
`session/new` response reports the default mode either way). bb's thread
permission mode therefore maps like this:

| bb mode      | Behaviour |
| ------------ | --------- |
| Auto         | Kimi asks for every tool call through bb's native approval cards |
| Accept edits | Same prompting as Auto; bb additionally denies `fs/write_text_file` outside the workspace roots |
| Full access  | bb itself answers every permission request with allow-once — nothing prompts |

To give Kimi more autonomy, set its own session mode — Kimi advertises it
over ACP as the `mode` session option (`auto` = auto-approve safe operations,
`yolo` = auto-approve everything), and bb exposes it in the thread options,
e.g. `bb thread spawn --option mode=auto`. Durable per-tool rules live in
`[[permission.rules]]` in `~/.kimi-code/config.toml`.

## Usage panel

The plugin registers as a bb **provider-usage** source, so Kimi appears in
bb's Provider usage panel with the quota windows of your Kimi For Coding
subscription (5-hour, weekly, monthly) plus plan and account email.

Measurements are local: the plugin reads the CLI's OAuth credentials in
`~/.kimi-code/credentials/`, refreshes the access token when it nears expiry
(tokens live ~15 minutes, the CLI does the same) and calls the coding API's
`/usages` and `/me` endpoints. The base URL follows `KIMI_CODE_BASE_URL` or
`[providers."managed:kimi-code"]` in `~/.kimi-code/config.toml`, defaulting
to `api.kimi.com` with a fallback to `api.kimi.ai`. Tokens are never logged.
The CLI equivalent:

```bash
bb kimi usage
```

## Check or repair

```bash
bb kimi status
bb kimi repair
bb plugin reload kimi        # clears a boot-time needs-configuration status
bb provider models acp-kimi
```

At boot the plugin reuses the recorded absolute path to `kimi`, so a wrapper
you pinned survives restarts. `bb kimi repair` instead re-resolves the binary
from the search order — use it when the CLI moved after an upgrade or the
recorded path points at a stale install; bb picks the new path up for the
next thread.

## Uninstall

Remove the managed provider entry before removing the plugin:

```bash
bb kimi unregister
bb plugin remove kimi
```

## How it works

bb's built-in ACP provider supplies the ACP-to-bb runtime. This plugin manages
the provider-specific launch profile in that plugin's `customAgents` setting.
The legacy `customAcpAgents` array in `config.json` was removed in bb 0.41; the
plugin only ever strips a leftover entry of its own from it, never registers
one there. Authentication and model availability remain owned by the Kimi CLI
and the user's account.

The package ID is `kimi`; the provider ID is `acp-kimi`. The compact icon is an
original crescent-and-star mark drawn as a `currentColor` mask so it follows
the bb theme.

## Development

```bash
npm run typecheck
npm test
npm run build
```

The plugin requires bb 0.40+ and plugin SDK 0.6.104+. Server code is adapted
from [bb-auggie](https://github.com/ai-ecoverse/bb-auggie) (MIT), the reference
implementation of this integration pattern.
