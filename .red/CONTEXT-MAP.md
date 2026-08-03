# Context Map — red-dev

Bounded contexts split by **subject** (language boundary), never by OS nor by implementation layer — OS is an adapter, layer is a stratum (see ADR 0001).

| Context | Subject | Glossary |
|---|---|---|
| `provisioning` | Convergence engine: manifest, providers, plan/apply, clean-machine proof | `.red/contexts/provisioning/CONTEXT.md` |
| `profiles` | Machine intent: profiles, requirement tiers, readiness | `.red/contexts/profiles/CONTEXT.md` |
| `interaction` | Semantic actions: hotkeys, tiling, workspaces, launcher | `.red/contexts/interaction/CONTEXT.md` |
| `visual` | Visual system: themes, fonts, wallpapers, config ownership | `.red/contexts/visual/CONTEXT.md` |
| `agents` | Agent hosts, RedSkills, MCPs, and agent accessibility | `.red/contexts/agents/CONTEXT.md` |
| `lifecycle` | Self-update of the binary, channels, rollback, origin verification | *(no resolved terms yet)* |

## Relationships

- `profiles` **consumes** `provisioning`: a profile is intent; the engine is what converges it.
- `interaction`, `visual`, and `agents` define **platform-neutral contracts**; each OS joins as an adapter inside the context, never as a context of its own.
- `lifecycle` is cross-cutting and runs on its own track (decision from the 2026-08-03 session).
