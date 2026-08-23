# Changelog

## 1.1.0

Stable open-source freeze of the V1 MCP supervisor.

### Added

- MCP task delegation (`bridge_run` and the rest of the `bridge_*` loop)
- ACP worker execution for Claude Code and DeepSeek Harness
- Isolated git worktrees; workers must not commit / push / merge
- Independent verification from a frozen `verify.json` plan
- ReviewPacket / ReviewDigest
- Immutable checkpoint + CAS task-branch update
- Guarded cherry-pick apply
- Human `doctor` report: missing / why / fix
- Golden-path e2e: permission → verify → review → approve → apply

### Changed

- License: MIT → Apache-2.0

### DeepSeek

- Legacy source ACP is supported
- Official ACP runtime migration is pending upstream (ADR-004)
- Bridge does not manage model / provider / reasoning effort

### Fixed

- DeepSeek status no longer treats a source checkout as official runtime ready
- README no longer claims DeepSeek inherits the user's current persistent model
