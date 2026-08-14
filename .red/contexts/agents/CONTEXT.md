# Context: agents

Agent hosts, RedSkills, MCPs, and RedDB products' accessibility to agents.

## Agent host

An agent client program that consumes RedSkills on a provisioned machine. Decided supported set: Claude Code, Codex, RedCode, Gemini, Pi, and Hermes — all six with shared skills and doctor verification. RedCode is the installed OpenCode-compatible host; existing OpenCode installations are retained but are no longer selected or managed. Hermes depends on official upstream RedSkills support.

## MCP posture

CLI-first: every required capability has a stable CLI path; MCP is optional acceleration. An MCP failure never brings down a required item's readiness — the item stays `healthy` with a `degraded(reason, fallback, remediation)` state pointing at the CLI fallback.
