# bb-plugin-kimi

npm package: `bb-plugin-kimi` (marketplace installs from git, not npm)
bb plugin id: `kimi` (from package name `bb-plugin-kimi`)
provider id: `acp-kimi`
CLI: `bb kimi status`, `bb kimi repair`, `bb kimi unregister`
Marketplace entry: `get-bb/marketplace` `entries/kimi.json`
Current range: `^0.1.0` → node-semver `>=0.1.0 <0.2.0-0`

# Release

## Building dist/

If `bb plugin build .` stalls in a working tree with `node_modules`, build
from a clean copy instead (`git archive HEAD | tar -x -C /tmp/kimi-build` and
run `bb plugin build .` there), then copy `dist/` back and commit it.

## Do not move a tag

bb resolves a marketplace `range` with node-semver `maxSatisfying` over this
repo's `vX.Y.Z` tags, records the tag **and** the commit it selected, and
refuses a tag that later points elsewhere. Never `git tag -f`, never
delete-and-recreate, never retarget. Publish a fix as a new version.

## The range trap

Caret on `0.x` pins the **minor**: with range `^0.1.0`, tagging `0.2.0` is not
enough — users stay on `0.1.x` until `entries/kimi.json` `source.git.range`
changes to `^0.2.0`. A patch (`0.1.1`) ships by tagging alone.

Open a reviewed marketplace PR (must come from `author.github`) when any of
these change: `id`, `displayName`, `description`, `tags`, `icon`,
`source.git.url`, `source.git.range`, `author.*`.

## Pre-release checklist

```bash
npm version patch --no-git-tag-version    # or: minor
npm run typecheck
npm test
bb plugin build .
git diff --exit-code dist                 # committed dist/ must match sources
```

`dist/server.meta.json` and `dist/app.meta.json` `pluginVersion` must equal
`package.json` `version`, and `pluginId` must be `kimi`. Managed installs
reject a mismatch. Commit `package.json`, `package-lock.json`, `dist/` and the
source change together; push `main`; only then tag.

## Local verification (before tagging)

```bash
bb plugin install . --yes
bb plugin reload kimi
bb plugin list
bb kimi status
bb provider models acp-kimi
bb plugin logs kimi -n 20
```

Expect `kimi@<version> running`; `bb kimi status` exit 0 with
`CLI: <path to kimi>`, `ACP customAgents entry: present`,
`legacy config.json entry: absent`, `bb provider acp-kimi: registered`;
`bb provider models acp-kimi` prints the live Kimi catalog
(`kimi-code/k3`, `kimi-code/kimi-for-coding`, …).

Boot can emit a `warn` `Could not read provider-acp customAgents: … HTTP 404`
while ACP settings race the factory — expected if a later info line shows
provisioning succeeded.

Do not run `bb kimi unregister` as part of a release.

## Publishing checklist (first submission)

1. Repo name `bb-plugin-kimi`, tagged with the `bb-plugin` topic.
2. `v0.1.0` tag pushed, GitHub release created with `--verify-tag`.
3. PR to `get-bb/marketplace` adding `entries/kimi.json`
   (`source.git.url`, `source.git.range: ^0.1.0`, author block).
4. Optional: PR to `MGrin/awesome-bb-plugins` adding the entry under
   **Providers**.
