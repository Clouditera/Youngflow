# Changelog

## 0.3.2 - 2026-06-11

### Fixed
- Inherit user global `~/.pi/agent/auth.json` subscription OAuth tokens into the flow's isolated `.pi-agent/`, so builtin subscription models (ChatGPT/Codex, Claude Pro/Max, Copilot) pass the v0.3.0 startup precheck instead of failing on missing key. Falls back to `{}` when global auth is empty, missing, or corrupt.

## 0.3.1 - 2026-06-11

### Fixed
- Apply declared `inputs.*.default` values from flow.yaml when no CLI value is given. Previously only engine built-ins (`work_dir`/`output_dir`) received defaults, so an optional input with a declared default was omitted from flow inputs and its `${flow_inputs.x}` token leaked into prompts unsubstituted.

## 0.3.0 - 2026-06-11

### BREAKING
- Removed `LLM_*` / `MODEL_*` environment variable translation. YoungFlow now uses pi-native model configuration: builtin providers use standard pi key env vars, and custom/multi-provider flows provide `artifacts.models_json`.

### Added
- Added direct `models.json` passthrough into `.pi-agent/models.json` and startup model availability precheck via `pi --list-models`.

## 0.2.15 - 2026-06-06

### Fixed
- Reduced long-running flow memory growth by moving map worker results into a transient `_worker_results` channel and keeping `stage_results` to one summary per stage execution.
- Fixed repeated map-stage aggregation so each collector summarizes only the current round, not historical same-stage worker results.
- Throttled live report refresh to reduce repeated full-log parsing during large fan-outs; final report is still force-flushed.

### Changed
- End-of-run `stages_total` now reflects stage executions rather than individual map worker invocations.

## 0.2.14 - 2026-06-06

### Fixed
- Fixed DeepSeek custom/proxy `developer` role 400 errors by restoring explicit `compat.supportsDeveloperRole: false` override for custom DeepSeek models (issue #26).
- Kept ZAI custom model config simplified to provider-only detection with `reasoning: true` and no compat override.

## 0.2.13 - 2026-06-06

### Added
- Added agent-readable `session.md` export next to pi session `.jsonl`/`.html`, preserving text, thinking, and tool calls while truncating tool results.

## 0.2.12 - 2026-06-05

### Fixed
- State `glob` rules can now apply the same file `filter` semantics as map stages before counting matches, preventing routes from dispatching map stages whose filters would select zero items.
- Concurrent route decisions are now stage-scoped instead of sharing a last-write-wins `_route_targets` field, preserving independent downstream routes after fan-out branches complete in parallel.

## 0.2.11 - 2026-06-05

### Added
- Map stage `filter` now supports Markdown frontmatter (`.md` / `.markdown`) and JSON (`.json`) files in addition to YAML.
- Markdown files without frontmatter are skipped with a warning when used with map filters.

## 0.2.10 - 2026-06-05

### Added
- Added structured `.youngflow/execution.jsonl` persistence for stage/engine events, including per-worker `iterate_file` context and `stage_done.session_file`; active execution logs are archived by `--continue`.
- Added Execution Timeline in `flow-report.html`, replacing the static Flow Graph when `execution.jsonl` exists. It shows actual per-instance execution order, repeated loop nodes, fork/join structure, map worker details, and session links.
- Added Run History columns: Stages, Tokens, Tools, Failures, and Model.

### Changed
- Stage Details now use a horizontal grid layout with bounded, scrollable worker tables; failed worker details open by default.
- Older runs without `execution.jsonl` continue to fall back to the previous static Flow Graph.

### Fixed
- Interrupted runs now write `status: interrupted`, `ended_at`, and `duration_ms` on SIGINT/SIGTERM.
- Running `run.yaml` now updates `duration_ms` continuously during report refresh.
- `--continue` now repairs stale active `status: running` metadata to `interrupted` before archiving.
- Archived stale `running` runs display as `interrupted` in Run History.

## 0.2.9 - 2026-06-04

### Changed
- Removed automatic stage/worker output subdirectory creation before agent execution.
- Agents now create any needed output subdirectories on demand via their own tools; `.youngflow/` engine metadata is unchanged.

## 0.2.8 - 2026-06-04

### Changed
- Optimized the binary build pipeline with esbuild tree-shaking before pkg packaging.
- Reduced release binary size significantly (linux ~99MB to ~57MB) with no runtime behavior changes.

## 0.2.7 - 2026-06-04

### Added
- Added map stage `filter` for YAML field-based item filtering with `match`, `not_match`, `in`, `not_in`, and `include_missing`.
- Map glob results are filtered before worker dispatch; excluded files do not start agent sessions or create item checkpoints/log entries.

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
