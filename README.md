# goal-lite

DSH-compatible same-session goals for OpenCode 2.2.5+.

Three adapters share one durable goal store:

- model tools: `get_goal` / `create_goal` / `update_goal`
- human command: `/gl`
- idle driver: injects one `<goal_round>` message when the session goes idle

Semantics mirror `@deepseek-ai/dsh-goal` + `dsh-tool-goal` + `dsh-goal-round-driver`:

- one goal per session;
- phases `active | paused | blocked | complete`;
- `revision` compare-and-set, +1 on every durable change except a round start;
- `roundsStarted` only counts admitted goal rounds;
- `activation` is process-local and starts `disarmed`;
- no `acceptance_criteria` and no independent completion reviewer.

## Install

### Windows

```powershell
.\install.ps1
```

Target: `%USERPROFILE%\.config\opencode\plugins\goal-lite\` (`index.ts`, `rpc.ts`, `tui.tsx`)

### macOS / Linux

```bash
bash install.sh
```

Target: `~/.config/opencode/plugins/goal-lite/` (`index.ts`, `rpc.ts`, `tui.tsx`)

### Config

In `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@openviking/opencode-plugin", "-opencode.goal"],
  "experimental": {
    "todo": true
  }
}
```

- `-opencode.goal` removes OpenCode's built-in `/goal` command and its idle loop. Without it two goal systems would run.
- `@openviking/opencode-plugin` is only needed when that plugin is installed. If OpenViking is configured as an MCP server instead (the current macOS setup), use `"plugins": ["-opencode.goal"]`.
- `experimental.todo` enables the built-in `todowrite`.
- The local plugin directory loads automatically; it does not need an entry in `plugins`.
- No `package.json` and no npm dependencies: the server part exports a plain `{ id, setup }` object; `rpc.ts` and `tui.tsx` provide the sidebar and floating dialog.

Restart OpenCode completely after changing the config.

## Commands

| Input | Effect |
|---|---|
| `/gl` | show status |
| `/gl <objective>` | create |
| `/gl edit <objective>` | change objective |
| `/gl pause` | active → paused |
| `/gl resume` | paused/blocked/active-disarmed → active; starts the next round |
| `/gl clear` | delete the goal |

`/gl` output is delivered as a command error because OpenCode v2 commands have no success-output channel. The text is visible in the UI and does not enter model history.

## TUI sidebar and floating dialog

The TUI part adds a compact goal block at the top of the right sidebar (`sidebar.content`):

- phase, `rounds/max` continuation budget, and a progress bar (this is not a completion percentage);
- the objective;
- an `armed`/`disarmed` warning after a server restart;
- the blocker message when the goal is blocked;
- for a complete goal, `✓ Completed in N rounds` instead of the budget bar.

Click the block, run `/gl-view` (alias `/gls`), or press `Ctrl+Shift+G` to open a floating goal dialog. The dialog shows the full objective, phase, rounds, activation, and blocker, with clickable `[pause]`, `[resume]`, and `[clear]` actions. The dialog host does not route plugin keymap layers, so keyboard users should close it and use `/gl pause`, `/gl resume`, or `/gl clear` from the prompt.

The floating dialog is independent of the sidebar, so it still works when the sidebar auto-hides on a narrow terminal. Slash completion may require Enter once to complete `/gl-view` and a second Enter to submit it.

The TUI shares goal state through a `goal-lite` RPC (`get` / `pause` / `resume` / `clear` plus a `changed` event). Every durable goal write publishes `changed`, so the sidebar and dialog update live.

## Tools

- `get_goal()` → `{ goal: null }` or `{ goal: {...}, activation: "armed" | "disarmed" }`
- `create_goal(objective, max_goal_rounds?)`
- `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)`

Authority:

- `create_goal`, `edit`, `pause`, `resume`: direct human turn on a top-level agent only.
- `complete`, `blocked`: direct human turn or the exact current goal round.
- `blocked` during a goal round requires at least 3 rounds.
- The model cannot resume a durable `paused` goal (`GOAL_TOOL_RESUME_PAUSED`); use `/gl resume`.

## State

Stored through OpenCode's plugin storage (`ctx.storage`), key `session:<sessionID>`.

Every durable mutation is serialized per session. Inside one process the plugin uses an async queue; across server processes on the same host it also takes a per-session lock file under the OS temp directory (`opencode-goal-lite-locks`). A second process waits up to 15 seconds, then fails the operation instead of overwriting state. A lock left by a dead process is reclaimed. A lock from another host is reclaimed after five minutes, so a shared database must not be mutated by live processes on different hosts.

`activation`, `busy`, deferred starts, and idle driving remain process-local. The lock prevents lost goal updates, but it does not coordinate two processes that independently drive the same armed session; run one server process per session.

A new process starts with every goal disarmed. An active goal keeps its phase but does not continue until a human asks and the model calls `update_goal(action="resume")`, or a human runs `/gl resume`.

## Development

```bash
node test.mjs
```

45 semantic tests, no model or server required.

Known deviations from DSH:

- storage is plugin JSON instead of an event-sourced session log;
- durable goal writes are cross-process safe on one host, but activation and idle driving stay process-local, so one server process should own a session;
- `/gl` output is a command error (UI only);
- `/gl create|edit|resume` sends the next round itself, because OpenCode commands do not trigger idle;
- default `maxGoalRounds` is 50 (DSH uses 256);
- reopening an old session in the same process does not disarm an armed goal (only a process restart does);
- no post-complete/post-blocked wrapup notice (OpenCode has no `deferContext` equivalent);
- the goal round is admitted inside the same execution, so the round message itself is the authority boundary; a command issued while the model is running defers its first round to the next idle boundary;
- after a process restart, `complete`/`blocked` inside a resumed round fall back to the round message in context; if a compaction removed it, the next round or a human turn restores authority;
- the driver waits for background shells, subagents, and images before starting the next round;
- goal objectives are capped at 4,000 characters.
