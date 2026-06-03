# Changelog

## 0.2.6 - 2026-06-03

### Fixed
- Fixed ZAI/GLM reasoning model detection for `glm-*` models and `bigmodel.cn` / `zhipuai` OpenAI-compatible endpoints.
- YoungFlow now sets provider `zai` plus `reasoning: true` for detected ZAI/GLM custom endpoints, letting pi infer compat and handle `enable_thinking` / `reasoning_content`.
- Simplified DeepSeek and ZAI custom model config generation to avoid duplicating pi compat rules; YoungFlow now writes only the provider name and `reasoning: true` for detected reasoning providers.

## 0.2.5 - 2026-05-14

### Added
- Added default multi-target conditional routing: all matching `when` routes are dispatched in the same routing decision.
- Added fallback-only semantics for no-`when` routes: fallback runs only when no conditional route matches.
- Added engine-only `type: join` stages for fan-out/fan-in flows; join stages do not call agent/pi and require no skills/task/prompt.
- Added persisted fork context so `--resume` can complete partial fan-out branches before join continuation.

### Changed
- Updated routing docs to explain multi-dispatch routes, fallback routes, and explicit join stages.

## 0.2.4 - 2026-05-12

### Added
- Added `--continue` to start a fresh engine run from existing output artifacts.
- Archived active `.youngflow` engine state into `.youngflow/runs/<timestamp>/` before continue runs.
- Added `run.yaml` metadata for active and archived runs.
- Added Run History to `flow-report.html` with links to archived reports, logs, and sessions.
- Added explicit LangGraph recursion limit support: default `100`, flow.yaml `recursion_limit`, and CLI `--recursion-limit <n>`.

### Changed
- Changed prompt assembly order to `task.md` before rendered `prompt`.
- Improved report P0 structure/accessibility: Current Run section, Run Ledger table, summary metrics, Stage Details, map/parallel worker table, failed-stage highlighting.
- Bumped release binaries to `0.2.4`.
