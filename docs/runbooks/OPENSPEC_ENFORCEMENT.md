# OpenSpec Enforcement Runbook

## Overview

This repo uses OpenSpec Level 2 enforcement: local pre-push validation via lefthook with CI-ready scripts.

## Why Repo-Local Dependencies

**Do not use `npx openspec` for enforcement.** Reasons:
- npx may fetch different versions across machines
- Network failures can cause inconsistent behavior
- No guarantee of version pinning

Instead, this repo pins `@fission-ai/openspec` as a devDependency and runs it via npm scripts.

## Lefthook as Hook Mechanism

Git hooks are managed via **lefthook**, a tracked configuration in `lefthook.yml`. This ensures:
- Hooks are version-controlled and reviewable
- All contributors get identical hook behavior
- No manual `.git/hooks/` file management

## Installation

After cloning or pulling, install hooks:

```bash
npm install
npm run hooks:install
```

This registers lefthook to manage git hooks.

## Validation Commands

```bash
# List all OpenSpec items
npm run openspec:list

# Validate all specs (strict mode)
npm run openspec:validate

# CI-compatible validation
npm run openspec:validate:ci
```

## Pre-Push Behavior

On `git push`, lefthook runs `scripts/openspec_validate.ps1`:
- Validates all specs in strict mode
- Blocks push if validation fails
- Provides clear error messages

## Bypass Protocol

For **non-behavior changes only** (docs, formatting, config):

```powershell
$env:OPENSPEC_BYPASS = "1"
git push
```

Or in bash/sh:

```bash
OPENSPEC_BYPASS=1 git push
```

**Warning:** Never bypass for changes that affect application behavior. The bypass exists for emergency documentation fixes and similar non-behavioral updates.

## Troubleshooting

### Hooks not running
```bash
npm run hooks:install
```

### Validation fails unexpectedly
```bash
npm run openspec:validate
```
Review output for specific spec failures.

### Need to bypass for legitimate non-behavior change
Set `OPENSPEC_BYPASS=1` environment variable before push.
