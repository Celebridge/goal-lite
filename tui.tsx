import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"
import { GoalLite, type GoalPublic } from "./rpc.ts"

function phaseLabel(goal: GoalPublic): string {
  switch (goal.phase) {
    case "active":
      return "active"
    case "paused":
      return "paused"
    case "blocked":
      return "blocked"
    case "complete":
      return "complete"
  }
}

function goalColor(theme: Plugin.Context["theme"], goal: GoalPublic): string {
  if (goal.phase === "paused") return theme.text.feedback.warning.base
  if (goal.phase === "blocked") return theme.text.feedback.error.base
  if (goal.phase === "complete") return theme.text.feedback.success.base
  return theme.text.base
}

function progressBar(rounds: number, max: number): string {
  const width = 10
  const filled = max > 0 ? Math.min(width, Math.round((rounds / max) * width)) : 0
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${rounds}/${max}`
}

function createGoal(context: Plugin.Context, sessionID: () => string | undefined) {
  const [goal, setGoal] = createSignal<GoalPublic>()
  const rpc = context.client.rpc(GoalLite)
  // A change that arrives while a fetch is in flight is newer than its reply.
  const turn = { value: 0 }

  const load = (id: string) => {
    const current = ++turn.value
    const directory = context.data.session.get(id)?.location.directory
    void rpc.get({ sessionID: id }, directory ? { location: { directory } } : undefined).then(
      (next) => {
        if (current === turn.value && sessionID() === id) setGoal((next ?? undefined) as GoalPublic | undefined)
      },
      () => undefined,
    )
  }

  onCleanup(
    rpc.events.on("changed", (event) => {
      const data = event.data as { sessionID: string; goal: GoalPublic | null }
      if (data.sessionID !== sessionID()) return
      turn.value++
      setGoal(data.goal ?? undefined)
    }),
  )

  onCleanup(
    context.data.on("server.connected", () => {
      const id = sessionID()
      if (id) load(id)
    }),
  )

  createEffect(
    on(sessionID, (id) => {
      setGoal(undefined)
      if (id) load(id)
    }),
  )

  return goal
}

function showGoalDialog(context: Plugin.Context, sessionID: string) {
  context.ui.dialog.set({ size: "large", centered: true })
  context.ui.dialog.show(() => <GoalDialog context={context} sessionID={sessionID} />)
}

function GoalDialog(props: { context: Plugin.Context; sessionID: string }) {
  const context = props.context
  const theme = context.theme
  const goal = createGoal(context, () => props.sessionID)
  const rpc = context.client.rpc(GoalLite)

  const run = async (action: "pause" | "resume" | "clear") => {
    try {
      if (action === "pause") await rpc.pause({ sessionID: props.sessionID })
      if (action === "resume") await rpc.resume({ sessionID: props.sessionID })
      if (action === "clear") {
        await rpc.clear({ sessionID: props.sessionID })
        context.ui.dialog.clear()
      }
    } catch (error) {
      context.ui.toast.show({
        title: "Failed to update the goal",
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }

  // The dialog host does not route plugin keymap layers to the focused
  // dialog, so the actions are mouse-driven. `/gl pause|resume|clear` remains
  // the keyboard path from the prompt.
  return (
    <Show when={goal()} fallback={<text fg={theme.text.muted}>No goal is set. Use /gl &lt;objective&gt;.</text>}>
      {(current) => (
        <box flexDirection="column" gap={1}>
          <text fg={theme.text.base}>
            <b>Goal</b>
          </text>
          <text fg={theme.text.base} wrapMode="word">
            {current().objective}
          </text>
          <box flexDirection="column" gap={0}>
            <text fg={goalColor(theme, current())} wrapMode="none">
              {phaseLabel(current())} · {current().roundsStarted}/{current().maxGoalRounds} · {current().activation}
            </text>
            <text fg={theme.text.muted} wrapMode="none">
              {progressBar(current().roundsStarted, current().maxGoalRounds)}
            </text>
            <Show when={current().blockedReason}>
              {(reason) => (
                <text fg={theme.text.feedback.error.base} wrapMode="word">
                  Blocker: {reason().code}: {reason().message}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <Show when={current().phase === "active"}>
              <text onMouseUp={() => void run("pause")}>[pause]</text>
            </Show>
            <Show
              when={
                current().phase === "paused" ||
                current().phase === "blocked" ||
                (current().phase === "active" && current().activation === "disarmed")
              }
            >
              <text onMouseUp={() => void run("resume")}>[resume]</text>
            </Show>
            <text onMouseUp={() => void run("clear")}>[clear]</text>
          </box>
          <text fg={theme.text.muted} wrapMode="word">
            Click an action; Esc closes. Use /gl pause|resume|clear from the prompt.
          </text>
          <text fg={theme.text.muted} wrapMode="word">
            /gl edit &lt;objective&gt; changes the objective
          </text>
        </box>
      )}
    </Show>
  )
}

function SidebarGoal(props: { context: Plugin.Context; sessionID: string }) {
  const context = props.context
  const theme = context.theme
  const goal = createGoal(context, () => props.sessionID)

  return (
    <Show when={goal()}>
      {(current) => (
        <box flexDirection="column" gap={0} onMouseUp={() => showGoalDialog(context, props.sessionID)}>
          <box flexDirection="row" gap={1}>
            <text fg={goalColor(theme, current())}>
              <b>Goal</b>
            </text>
            <text fg={theme.text.muted} wrapMode="none">
              {phaseLabel(current())} · {current().roundsStarted}/{current().maxGoalRounds}
            </text>
          </box>
          <text fg={theme.text.base} wrapMode="word">
            {current().objective}
          </text>
          <text fg={theme.text.muted} wrapMode="none">
            {progressBar(current().roundsStarted, current().maxGoalRounds)}
          </text>
          <Show when={current().phase === "active" && current().activation === "disarmed"}>
            <text fg={theme.text.feedback.warning.base} wrapMode="word">
              disarmed · /gl resume
            </text>
          </Show>
          <Show when={current().blockedReason}>
            {(reason) => (
              <text fg={theme.text.feedback.error.base} wrapMode="word">
                blocked: {reason().message}
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "goal-lite.tui",
  setup(context) {
    context.ui.slot({
      // Keep the goal above the long MCP/context sections in the right sidebar.
      prepend: "sidebar.content",
      render: (props) => <SidebarGoal context={context} sessionID={props.sessionID} />,
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "goal-lite.show",
          title: "Show goal",
          group: "Goal",
          bind: "ctrl+shift+g",
          palette: true,
          slash: { name: "gl-view", aliases: ["gls"] },
          run: () => {
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({ message: "Open a session first", variant: "info" })
              return
            }
            showGoalDialog(context, route.sessionID)
          },
        },
      ],
    }))
  },
})
