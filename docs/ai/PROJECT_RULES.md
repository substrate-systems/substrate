# Project Rules

## Behavior Changes Require OpenSpec Updates

Any change that modifies application behavior must have a corresponding OpenSpec update. This includes:
- New features
- Bug fixes that change observable behavior
- API changes
- Configuration changes affecting runtime behavior

## Hook Installation

Install git hooks via the repo-tracked mechanism:

```bash
npm run hooks:install
```

**Do not use `.git/hooks/` directly for enforcement.** The repo uses lefthook for tracked, reproducible hook management.

## Validation Commands

```bash
# List all specs
npm run openspec:list

# List specs only
npm run openspec:list:specs

# Validate all specs
npm run openspec:validate

# CI validation (PowerShell)
npm run openspec:validate:ci
```

## References

- [OPENSPEC_ENFORCEMENT.md](../runbooks/OPENSPEC_ENFORCEMENT.md) - Full setup and bypass procedures
- [AI_CONTRACT.md](./AI_CONTRACT.md) - AI agent contract
