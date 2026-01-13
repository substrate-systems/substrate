# AI Contract

This document defines the canonical contract between AI agents and this repository.

## OpenSpec as Canonical Source

**OpenSpec is the single source of truth for behavior changes.** All behavioral modifications to this codebase must be reflected in OpenSpec specifications before implementation.

## Enforcement Levels

| Level | Mechanism | Description |
|-------|-----------|-------------|
| 0 | None | No enforcement; specs are advisory only |
| 1 | Manual | Human review checks spec alignment |
| 2 | Local Gate | Pre-push hook validates specs via lefthook |
| 3 | CI Gate | CI pipeline blocks merge on spec violations |

**This repo operates at Level 2** with CI-ready validation scripts.

## Repo-Local Enforcement Principle

All enforcement tooling runs from repo-local dependencies. This ensures:
- Consistent versions across contributors
- No reliance on global installs or npx
- Reproducible validation results

## Bypass Protocol

For emergency situations involving **non-behavior changes only**:

```
OPENSPEC_BYPASS=1 git push
```

**Warning:** Bypass is for documentation fixes, formatting, or other non-behavioral changes. Never bypass for code that changes application behavior.

## References

- [OPENSPEC_ENFORCEMENT.md](../runbooks/OPENSPEC_ENFORCEMENT.md) - Setup and procedures
- [PROJECT_RULES.md](./PROJECT_RULES.md) - Development rules
