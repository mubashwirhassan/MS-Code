# MS Code

AI coding agent for VS Code — Claude Code–style autonomy with any provider.

## Build & Install

```bash
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension ms-code-1.0.0.vsix
```

## Features

- **Multi-provider:** OpenAI-compatible / Anthropic / Gemini / any custom Base URL
- **Test provider** → auto-fetches model IDs
- **Safe / Hybrid / Auto** execution modes (Auto default)
- File read, write, edit; glob search; terminal command execution
- Streaming responses, animated modern UI, custom agent instructions
- API keys stored in VS Code SecretStorage

## Usage

1. Activity Bar → **MS Code** icon
2. ⚙ Settings → add provider (label, type, base URL, API key) → **Test & Fetch Models** → Save
3. Pick execution mode (Safe / Hybrid / Auto)
4. Describe a task — the agent explores, edits files, and runs commands autonomously.

> Note: even in Auto mode, catastrophic commands (`rm -rf /`, disk format,
> `git push --force`, `curl | sh`, dropping databases…) are hard-blocked.
