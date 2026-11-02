<h1 align="center">claude-mods</h1>

<p align="center"><em>Small, single-purpose mods for Claude Code.</em></p>

<p align="center">
  <a href="https://github.com/Dhananjay-JSR/claude-mods/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Dhananjay-JSR/claude-mods/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-1A1614?style=flat-square">
  <img alt="No dependencies" src="https://img.shields.io/badge/dependencies-none-5FC4D4?style=flat-square">
</p>

One marketplace, a few mods, each doing one thing well. Every mod runs locally, carries no dependencies, and says what it reaches for before it runs.

## Install

```
/plugin marketplace add Dhananjay-JSR/claude-mods
```

That registers the catalog once. Install only the mods you want, below.

## Mods

### [intent-lens](plugins/intent-lens)

See what Claude is about to do, in one line above the prompt — and a red warning before a destructive shell command.

<p align="center">
  <img src="plugins/intent-lens/assets/demo.svg" alt="Three intent lines above a prompt: a Bash build, a model-phrased edit, and a red warning before a recursive delete" width="720">
</p>

```
/plugin install intent-lens@claude-mods
```

[Read the docs →](plugins/intent-lens)

Each mod has its own README with commands, internals, and limits. More land here as they are finished.

## Requirements

A current Claude Code. With Homebrew:

```bash
brew install --cask claude-code
brew upgrade --cask claude-code
```

## License

MIT.
