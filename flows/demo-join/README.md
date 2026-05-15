# Demo Join Flow

This flow demonstrates YoungFlow v0.2.5 routing semantics:

- all matching conditional routes are dispatched (`discovery -> research` and `discovery -> argument` can both run);
- a no-`when` route is fallback only (`discovery -> report` runs only when no pending markers exist);
- `type: join` is an engine-only barrier and does not call an agent;
- branch stages route to `join_branches`, which then routes downstream once.

Automated tests use this topology with a fake executor so the demo is deterministic and does not require LLM credentials.

List stages:

```bash
youngflow flows/demo-join/flow.yaml --list-stages
```
