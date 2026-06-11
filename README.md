Markway for Obsidian syncs Markdown notes with Apple Journal through the [Markway](https://github.com/anupchavan/markway) app.

It is the Obsidian adapter for the larger Markway project: a gateway between Apple services and Markdown. The plugin watches eligible Markdown files, asks the native Markway app to push or pull Journal entries, and keeps sync metadata in plugin data instead of cluttering note frontmatter.

## Requirements

- Obsidian desktop.
- Markway.app installed and configured.
- A local Obsidian vault.
- macOS with Apple Journal available.

The plugin is desktop-only because the current Journal bridge depends on macOS.

## Installation

Markway for Obsidian can be installed from the Obsidian Community Plugins browser or manually from GitHub releases.

- Obsidian Community Plugins: [community.obsidian.md/plugins/markway](https://community.obsidian.md/plugins/markway)
- GitHub releases: [github.com/anupchavan/obsidian-markway/releases](https://github.com/anupchavan/obsidian-markway/releases)

Manual installation from GitHub releases:

1. Install and open Markway.app.
2. Choose your vault in Markway.app.
3. Grant Full Disk Access to Markway.app.
4. Download the plugin release files:
   - `main.js`
   - `manifest.json`
   - `styles.css`
5. Place them in:

```text
<vault>/.obsidian/plugins/markway/
```

6. In Obsidian, enable Community plugins and enable Markway.

## Settings

The plugin supports both Obsidian's legacy settings renderer and the newer declarative settings API.

Main settings:

- Automatic sync: push/pull after edits and bridge events.
- Debounce: delay before automatic push.
- Vault path override: fallback when Obsidian cannot expose a local path.

Journal settings:

- Journal folder: default folder for imported Journal entries.
- Rules: filter which Markdown files should sync.
- Delete Journal entries when synced Markdown files are deleted.
- Delete Markdown files when synced Journal entries are deleted.
- Properties: frontmatter templates generated from Journal data.
- Add title as heading: optionally render Journal title as the first Markdown heading.

Default rule:

```text
folder is Journal
```

## Template Properties

Journal template properties let you generate frontmatter without deleting unrelated user properties.

Example:

```text
music = {{music|map:item => item.title|wikilink}}
```

This can produce:

```yaml
music:
  - "[[Sahiba]]"
  - "[[How Do You Know]]"
```

Supported variables include:

- `title`
- `content`
- `created`
- `modified`
- `music`

More attachment variables will be added as Markway decodes them.

## Commands

The plugin registers commands for:

- Push current file to Journal.
- Pull current file from Journal.
- Sync Journal now.
- Run diagnostics.

Command names are intentionally Obsidian-facing; low-level Journal access stays in Markway.app.

## Development

Install dependencies:

```zsh
npm install
```

Run checks:

```zsh
npm run lint
npm run build
npm test
```

During development:

```zsh
npm run dev
```

The source is organized under:

- `src/bridge`
- `src/journal-template`
- `src/rules`
- `src/settings`
- `src/sync`

Root files such as `src/sync-utils.ts` are compatibility barrels for stable imports.

## Release

The plugin release workflow is:

```text
.github/workflows/release.yml
```

Create a tag:

```zsh
git tag 0.1.2
git push origin 0.1.2
```

The workflow builds and publishes a draft GitHub release containing:

- `main.js`
- `manifest.json`
- `styles.css`

## What To Commit

Commit:

- `.github`
- `src`
- `test`
- `styles.css`
- `manifest.json`
- `versions.json`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `eslint.config.mts`
- `esbuild.config.mjs`
- `version-bump.mjs`
- `README.md`

Do not commit:

- `node_modules`
- `main.js`
- `data.json`
- source maps
- `.DS_Store`

## Disclaimer

Markway is not affiliated with Obsidian or Apple. Apple Journal support depends on Markway.app and its reverse-engineered Journal bridge.
