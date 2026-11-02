// goal-lite — DSH-compatible same-session goals for OpenCode.
//
// One durable goal per session, shared by three independent adapters:
//   - model tools: get_goal / create_goal / update_goal
//   - human command: /gl
//   - idle driver: injects one <goal_round> message when the session goes idle
//
// Semantics mirror @deepseek-ai/dsh-goal + dsh-tool-goal + dsh-goal-round-driver:
//   phase: active | paused | blocked | complete
//   revision: compare-and-set token, +1 on every durable change except a round start
//   roundsStarted: incremented only when a goal round message is admitted
//   activation: process-local continuation permission, disarmed on load
//   no acceptance_criteria and no independent completion reviewer

import { GoalLite, type GoalPublic } from "./rpc.ts"

const SOURCE = "goal-lite"
const STORAGE_PREFIX = "session:"
const DEFAULT_MAX_GOAL_ROUNDS = 50
const BLOCKED_AFTER_CONSECUTIVE_ROUNDS = 3
const MAX_OBJECTIVE = 4_000

const USAGE = "Usage: /gl [<objective>|clear|edit <objective>|pause|resume]"

type Phase = "active" | "paused" | "blocked" | "complete"

interface BlockedReason {
  code: string
  message: string
}

interface GoalState {
  id: string
  revision: number
  objective: string
  phase: Phase
  roundsStarted: number
  maxGoalRounds: number
  blockedReason?: BlockedReason
  createdAt: number
  updatedAt: number
}

interface GoalRef {
  id: string
  revision: number
}

/** Process-local continuation authority. A fresh process starts disarmed, like DSH. */
const armed = new Set<string>()

/**
 * Per-session mutation queue. `ctx.storage` has no compare-and-set, so a
 * read-modify-write pair from two adapters (command, tool, idle hook, event
 * listener) could otherwise lose an update — for example a `/gl pause` that
 * lands between `startRound`'s read and its write.
 */
const queues = new Map<string, Promise<unknown>>()

/** Sessions with a model execution in flight, from execution lifecycle events. */
const busy = new Set<string>()

/** The goal round admitted for the current execution, used for authority after compaction. */
interface ActiveRound {
  goalID: string
  revision: number
  round: number
  admittedAt: number
}

const activeRounds = new Map<string, ActiveRound>()

/** Avoid logging the same corrupt state on every context request. */
const warnedCorrupt = new Set<string>()

/** Set while the RPC registration is live, so durable writes notify the TUI sidebar. */
let notifyGoalChanged: ((sessionID: string, goal: GoalState | undefined) => void) | undefined

/** Commands issued during a running turn defer their first round to the next idle boundary. */
const pendingStart = new Set<string>()

function serialize<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(sessionID) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  const tail = next.catch(() => {})
  queues.set(sessionID, tail)
  void tail.then(() => {
    if (queues.get(sessionID) === tail) queues.delete(sessionID)
  })
  return next
}

const PHASES: ReadonlySet<string> = new Set(["active", "paused", "blocked", "complete"])

function fail(message: string, code?: string): never {
  throw new Error(code === undefined ? message : `${code}: ${message}`)
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
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

/** Commands that are meaningful from one exact live state (DSH commandHint). */
function commandHint(goal: GoalState, sessionID: string): string {
  if (goal.phase === "active") {
    return isArmed(goal, sessionID)
      ? "/gl edit <objective>, /gl pause, /gl clear"
      : "/gl edit <objective>, /gl resume, /gl clear"
  }
  switch (goal.phase) {
    case "paused":
    case "blocked":
      return "/gl edit <objective>, /gl resume, /gl clear"
    case "complete":
      return "/gl <objective>, /gl clear"
  }
}

function isArmed(goal: GoalState, sessionID: string): boolean {
  return goal.phase === "active" && armed.has(sessionID)
}

/** Compact model-facing value, byte-for-byte the DSH goalValue shape. */
function goalValue(goal: GoalState | undefined, sessionID: string) {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...(goal.blockedReason === undefined
        ? {}
        : { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }),
    },
    activation: isArmed(goal, sessionID) ? "armed" : "disarmed",
  }
}

/** Render direct command output without exposing compare-and-set internals. */
/** Shape shared with the TUI sidebar and dialog. */
function publicGoal(goal: GoalState, sessionID: string): GoalPublic {
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds,
    ...(goal.blockedReason === undefined ? {} : { blockedReason: goal.blockedReason }),
    activation: isArmed(goal, sessionID) ? "armed" : "disarmed",
  }
}

function renderGoal(title: string, goal: GoalState, sessionID: string): string {
  const reason = goal.phase === "blocked" ? goal.blockedReason : undefined
  const blocker = reason === undefined ? [] : [`Blocker: ${reason.code}: ${reason.message}`]
  return [
    title,
    `Status: ${phaseLabel(goal.phase)}`,
    ...blocker,
    `Objective: ${goal.objective}`,
    `Rounds: ${goal.roundsStarted}/${goal.maxGoalRounds}`,
    `Activation: ${isArmed(goal, sessionID) ? "armed" : "disarmed"}`,
    "",
    `Commands: ${commandHint(goal, sessionID)}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Durable store
// ---------------------------------------------------------------------------

function decodeGoal(raw: unknown): GoalState | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== "string" || value.id.length === 0) return undefined
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1)
    return undefined
  if (typeof value.objective !== "string" || value.objective.trim().length === 0) return undefined
  if (typeof value.phase !== "string" || !PHASES.has(value.phase)) return undefined
  if (
    typeof value.roundsStarted !== "number" ||
    !Number.isSafeInteger(value.roundsStarted) ||
    value.roundsStarted < 0
  )
    return undefined
  if (typeof value.maxGoalRounds !== "number" || !Number.isSafeInteger(value.maxGoalRounds) || value.maxGoalRounds < 1)
    return undefined
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return undefined
  let blockedReason: BlockedReason | undefined
  if (value.blockedReason !== undefined) {
    const reason = value.blockedReason as Record<string, unknown>
    if (
      reason === null ||
      typeof reason !== "object" ||
      typeof reason.code !== "string" ||
      typeof reason.message !== "string"
    )
      return undefined
    blockedReason = { code: reason.code, message: reason.message }
  }
  return {
    id: value.id,
    revision: value.revision,
    objective: value.objective,
    phase: value.phase as Phase,
    roundsStarted: value.roundsStarted,
    maxGoalRounds: value.maxGoalRounds,
    ...(blockedReason === undefined ? {} : { blockedReason }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

async function readGoal(ctx: any, sessionID: string): Promise<GoalState | undefined> {
  const raw = await ctx.storage.get(STORAGE_PREFIX + sessionID)
  if (raw === undefined) return undefined
  const goal = decodeGoal(raw)
  if (goal === undefined) {
    if (!warnedCorrupt.has(sessionID)) {
      warnedCorrupt.add(sessionID)
      console.warn(`[goal-lite] ignoring invalid goal state for ${sessionID}`)
    }
    return undefined
  }
  warnedCorrupt.delete(sessionID)
  return goal
}

async function saveGoal(ctx: any, sessionID: string, goal: GoalState): Promise<void> {
  await ctx.storage.set(STORAGE_PREFIX + sessionID, goal)
  notifyGoalChanged?.(sessionID, goal)
}

async function removeGoal(ctx: any, sessionID: string): Promise<void> {
  await ctx.storage.remove(STORAGE_PREFIX + sessionID)
  armed.delete(sessionID)
  activeRounds.delete(sessionID)
  notifyGoalChanged?.(sessionID, undefined)
}

// ---------------------------------------------------------------------------
// Validation and domain transitions
// ---------------------------------------------------------------------------

function resolveObjective(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail("goal objective must be a non-empty string", "GOAL_INVALID_OBJECTIVE")
  const objective = value.trim()
  if (objective.length > MAX_OBJECTIVE)
    fail(
      `goal objective is limited to ${MAX_OBJECTIVE} characters (got ${objective.length})`,
      "GOAL_INVALID_OBJECTIVE",
    )
  return objective
}

function resolveMaxGoalRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail("maxGoalRounds must be a positive safe integer", "GOAL_INVALID_MAX_ROUNDS")
  return value
}

/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value: unknown): boolean {
  return value !== undefined && value !== ""
}

/** Whether an optional round cap is meaningful rather than a strict-schema zero filler. */
function hasRoundCap(value: unknown): boolean {
  return value !== undefined && value !== 0
}

/** Build the exact compare-and-set ref from model arguments. */
function goalRef(goalId: unknown, revision: unknown): GoalRef {
  if (
    typeof goalId !== "string" ||
    goalId.length === 0 ||
    goalId !== goalId.trim() ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    fail("goal_id must be non-empty and revision must be a positive safe integer", "GOAL_TOOL_INVALID_UPDATE")
  return { id: goalId, revision }
}

function expectCurrent(current: GoalState | undefined, ref: GoalRef): GoalState {
  if (current === undefined) fail(`no goal is currently set`, "GOAL_NOT_FOUND")
  if (current.id !== ref.id || current.revision !== ref.revision)
    fail(`goal "${ref.id}" is not at revision ${ref.revision}`, "GOAL_STALE_REVISION")
  return current
}

async function createGoal(
  ctx: any,
  sessionID: string,
  objective: unknown,
  maxGoalRounds?: unknown,
): Promise<GoalState> {
  const current = await readGoal(ctx, sessionID)
  if (current !== undefined && current.phase !== "complete")
    fail(`goal "${current.id}" already exists with phase "${current.phase}"`, "GOAL_ALREADY_EXISTS")
  const now = Date.now()
  const goal: GoalState = {
    id: `goal-${crypto.randomUUID()}`,
    revision: 1,
    objective: resolveObjective(objective),
    phase: "active",
    roundsStarted: 0,
    maxGoalRounds:
      maxGoalRounds === undefined ? DEFAULT_MAX_GOAL_ROUNDS : resolveMaxGoalRounds(maxGoalRounds),
    createdAt: now,
    updatedAt: now,
  }
  // Publish the armed state with the first change event; the RPC sidebar reads
  // `activation` from the same in-memory set.
  armed.add(sessionID)
  try {
    await saveGoal(ctx, sessionID, goal)
  } catch (error) {
    armed.delete(sessionID)
    throw error
  }
  activeRounds.delete(sessionID)
  return goal
}

async function editGoal(
  ctx: any,
  sessionID: string,
  ref: GoalRef,
  objective: unknown,
  maxGoalRounds: unknown,
): Promise<GoalState> {
  const current = expectCurrent(await readGoal(ctx, sessionID), ref)
  const changes: Partial<Pick<GoalState, "objective" | "maxGoalRounds">> = {}
  if (hasText(objective)) changes.objective = resolveObjective(objective)
  if (hasRoundCap(maxGoalRounds)) changes.maxGoalRounds = resolveMaxGoalRounds(maxGoalRounds)
  if (changes.objective === undefined && changes.maxGoalRounds === undefined)
    fail("goal edit requires objective and/or maxGoalRounds", "GOAL_INVALID_EDIT")
  const goal: GoalState = {
    ...current,
    ...changes,
    revision: current.revision + 1,
    updatedAt: Date.now(),
  }
  await saveGoal(ctx, sessionID, goal)
  activeRounds.delete(sessionID)
  return goal
}

async function pauseGoal(ctx: any, sessionID: string, ref: GoalRef): Promise<GoalState> {
  const current = expectCurrent(await readGoal(ctx, sessionID), ref)
  if (current.phase !== "active")
    fail(`goal "${current.id}" is ${current.phase}; pause requires active`, "GOAL_INVALID_TRANSITION")
  const goal: GoalState = { ...current, phase: "paused", revision: current.revision + 1, updatedAt: Date.now() }
  delete goal.blockedReason
  await saveGoal(ctx, sessionID, goal)
  armed.delete(sessionID)
  activeRounds.delete(sessionID)
  return goal
}

async function resumeGoal(ctx: any, sessionID: string, ref: GoalRef): Promise<GoalState> {
  const current = expectCurrent(await readGoal(ctx, sessionID), ref)
  if (current.phase !== "active" && current.phase !== "paused" && current.phase !== "blocked")
    fail(`goal "${current.id}" is ${current.phase}; resume requires active, paused or blocked`, "GOAL_INVALID_TRANSITION")
  if (current.phase === "active" && armed.has(sessionID))
    fail(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION")
  if (current.roundsStarted >= current.maxGoalRounds)
    fail(
      `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
      "GOAL_INVALID_TRANSITION",
    )
  const goal: GoalState = { ...current, phase: "active", revision: current.revision + 1, updatedAt: Date.now() }
  delete goal.blockedReason
  armed.add(sessionID)
  try {
    await saveGoal(ctx, sessionID, goal)
  } catch (error) {
    armed.delete(sessionID)
    throw error
  }
  activeRounds.delete(sessionID)
  return goal
}

async function completeGoal(ctx: any, sessionID: string, ref: GoalRef): Promise<GoalState> {
  const current = expectCurrent(await readGoal(ctx, sessionID), ref)
  if (current.phase === "complete")
    fail(`goal "${current.id}" is already complete`, "GOAL_INVALID_TRANSITION")
  const goal: GoalState = { ...current, phase: "complete", revision: current.revision + 1, updatedAt: Date.now() }
  delete goal.blockedReason
  await saveGoal(ctx, sessionID, goal)
  armed.delete(sessionID)
  activeRounds.delete(sessionID)
  return goal
}

function resolveBlockReason(reason: unknown): BlockedReason {
  const value = reason as Record<string, unknown> | undefined
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    typeof value.code !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.code) ||
    typeof value.message !== "string" ||
    value.message.trim().length === 0
  )
    fail(
      "goal block reason requires a lower-kebab-case code and a non-empty message",
      "GOAL_INVALID_BLOCK_REASON",
    )
  return { code: value.code, message: value.message.trim() }
}

async function blockGoal(
  ctx: any,
  sessionID: string,
  ref: GoalRef,
  reason: BlockedReason,
): Promise<GoalState> {
  const current = expectCurrent(await readGoal(ctx, sessionID), ref)
  if (current.phase !== "active")
    fail(`goal "${current.id}" is ${current.phase}; block requires active`, "GOAL_INVALID_TRANSITION")
  const goal: GoalState = {
    ...current,
    phase: "blocked",
    blockedReason: resolveBlockReason(reason),
    revision: current.revision + 1,
    updatedAt: Date.now(),
  }
  await saveGoal(ctx, sessionID, goal)
  armed.delete(sessionID)
  activeRounds.delete(sessionID)
  return goal
}

async function clearGoal(ctx: any, sessionID: string, ref: GoalRef): Promise<void> {
  expectCurrent(await readGoal(ctx, sessionID), ref)
  await removeGoal(ctx, sessionID)
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

interface Authority {
  directHuman: boolean
  goalRound: boolean
  goal: GoalState | undefined
}

/**
 * The open turn is everything after the last idle marker. Older sessions may not
 * carry idle markers in `session.context`, so fall back to the last admitted
 * user/synthetic message. The goal-round boundary is applied separately in
 * `turnAuthority`, because OpenCode admits a goal round inside the same
 * execution and therefore records no idle marker before it.
 */
function openTurn(messages: readonly any[]): readonly any[] {
  let start = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === "idle") {
      start = index + 1
      break
    }
  }
  if (start === 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const type = messages[index]?.type
      if (type === "user" || type === "synthetic") {
        start = index
        break
      }
    }
  }
  return messages.slice(start)
}

async function turnAuthority(ctx: any, context: any): Promise<Authority> {
  const sessionID: string = context.sessionID
  const session = await ctx.session.get({ sessionID })
  if (session?.parentID !== undefined) return { directHuman: false, goalRound: false, goal: undefined }
  const goal = await readGoal(ctx, sessionID)
  const turn = openTurn(await ctx.session.context({ sessionID }))

  // The latest admitted goal round in this turn is the authority boundary.
  // OpenCode admits the round inside the same execution, so there is no idle
  // marker between the human request and the round; treating the round itself
  // as the boundary matches DSH's separate goal turn.
  let roundIndex = -1
  let roundRevision: number | undefined
  if (goal !== undefined) {
    for (let index = turn.length - 1; index >= 0; index -= 1) {
      const message = turn[index]
      if (
        message?.type !== "synthetic" ||
        message?.metadata?.source !== SOURCE ||
        message?.metadata?.goalID !== goal.id ||
        message?.metadata?.round !== goal.roundsStarted
      )
        continue
      roundIndex = index
      roundRevision = message?.metadata?.revision
      break
    }
  }

  const active = activeRounds.get(sessionID)
  const inMemoryRound =
    goal !== undefined &&
    active !== undefined &&
    goal.phase === "active" &&
    active.goalID === goal.id &&
    active.revision === goal.revision &&
    active.round === goal.roundsStarted

  const goalRound =
    goal !== undefined &&
    goal.phase === "active" &&
    (inMemoryRound || (roundIndex !== -1 && roundRevision === goal.revision))

  // When compaction removed the round message, `inMemoryRound` still proves
  // this is a goal round. A human steer admitted after the round must still
  // count as direct-human authority; compare message times against the round's
  // admission time so the original user message is not mistaken for a steer.
  const humanAfterAdmitted =
    active !== undefined &&
    turn.some(
      (message) =>
        message?.type === "user" &&
        typeof message?.time?.created === "number" &&
        message.time.created > active.admittedAt,
    )

  const directHuman =
    roundIndex !== -1
      ? turn.slice(roundIndex + 1).some((message) => message?.type === "user")
      : inMemoryRound
        ? humanAfterAdmitted
        : turn.some((message) => message?.type === "user")

  return { directHuman, goalRound, goal }
}

function requireDirectHuman(authority: Authority): void {
  if (authority.directHuman) return
  fail(
    "this goal operation requires a direct human turn on a top-level agent",
    "GOAL_TOOL_AUTHORITY_REQUIRED",
  )
}

function completionAuthority(authority: Authority): "direct-human" | "goal-round" {
  if (authority.directHuman) return "direct-human"
  if (authority.goalRound) return "goal-round"
  fail(
    "complete and blocked require a direct human turn or the current goal round",
    "GOAL_TOOL_AUTHORITY_REQUIRED",
  )
}

// ---------------------------------------------------------------------------
// Goal rounds
// ---------------------------------------------------------------------------

/** Model-visible continuation prompt, identical to dsh-goal-round-driver. */
function renderGoalRound(goal: GoalState, round: number): string {
  return `<goal_round>
Objective: ${JSON.stringify(goal.objective)}
Round: ${round}/${goal.maxGoalRounds}

Continue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.
</goal_round>`
}

/**
 * Reserve and admit the next round. The durable round counter advances before
 * the message is admitted and rolls back if admission fails, so a crash can
 * never leave an uncounted round in history.
 */
async function startRound(
  ctx: any,
  sessionID: string,
  expected: GoalState,
  delivery?: "steer" | "queue",
): Promise<{ started: boolean; goal: GoalState }> {
  const current = await readGoal(ctx, sessionID)
  if (current === undefined || current.id !== expected.id || current.revision !== expected.revision)
    return { started: false, goal: current ?? expected }
  if (current.phase !== "active") return { started: false, goal: current }
  if (current.roundsStarted >= current.maxGoalRounds) {
    const blocked = await blockGoal(ctx, sessionID, goalRef(current.id, current.revision), {
      code: "round-limit",
      message: `Goal reached its configured limit of ${current.maxGoalRounds} rounds.`,
    })
    return { started: false, goal: blocked }
  }

  const round = current.roundsStarted + 1
  const reserved: GoalState = { ...current, roundsStarted: round, updatedAt: Date.now() }
  await saveGoal(ctx, sessionID, reserved)
  try {
    await ctx.session.synthetic({
      sessionID,
      text: renderGoalRound(reserved, round),
      description: `Goal: ${truncate(reserved.objective, 120)}`,
      metadata: { source: SOURCE, goalID: reserved.id, revision: reserved.revision, round },
      ...(delivery === undefined ? {} : { delivery }),
    })
  } catch (error) {
    const latest = await readGoal(ctx, sessionID)
    if (
      latest !== undefined &&
      latest.id === current.id &&
      latest.revision === current.revision &&
      latest.roundsStarted === round
    )
      await saveGoal(ctx, sessionID, current)
    activeRounds.delete(sessionID)
    throw error
  }
  activeRounds.set(sessionID, {
    goalID: reserved.id,
    revision: reserved.revision,
    round,
    admittedAt: Date.now(),
  })
  return { started: true, goal: reserved }
}

/** DSH driver: only an active, armed goal that is not waiting on background work. */
async function drive(ctx: any, sessionID: string, background: readonly any[]): Promise<boolean> {
  const goal = await readGoal(ctx, sessionID)
  if (goal === undefined || goal.phase !== "active" || !armed.has(sessionID)) return false
  const session = await ctx.session.get({ sessionID })
  if (session?.parentID !== undefined) return false
  const waiting = background.some(
    (work) =>
      work?.sessionID === sessionID &&
      (work.kind === "subagent" || work.kind === "image" || work.kind === "shell"),
  )
  if (waiting) return false
  const result = await startRound(ctx, sessionID, goal)
  return result.started
}

function truncate(text: string, length: number): string {
  const line = text.replace(/\s+/g, " ")
  return line.length > length ? `${line.slice(0, length - 1)}…` : line
}

// ---------------------------------------------------------------------------
// /gl command
// ---------------------------------------------------------------------------

type GlCommand =
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "invalid-edit" }
  | { kind: "edit"; objective: string }
  | { kind: "create"; objective: string }

/** Parse only the grammar owned by /gl; arbitrary other input is an objective. */
function parseGl(rawInput: string): GlCommand {
  const input = rawInput.trim()
  if (input.length === 0) return { kind: "show" }
  const control = input.toLowerCase()
  if (control === "clear") return { kind: "clear" }
  if (control === "pause") return { kind: "pause" }
  if (control === "resume") return { kind: "resume" }
  if (control === "edit") return { kind: "invalid-edit" }
  if (/^edit(?=\s)/iu.test(input)) return { kind: "edit", objective: input.slice(4).trim() }
  return { kind: "create", objective: input }
}

/**
 * Start the first round only when the session is idle. A command issued while
 * the model is running must not inject a second round; the idle hook starts
 * the next round when the running turn ends.
 */
async function startFromCommand(
  ctx: any,
  sessionID: string,
  goal: GoalState,
  delivery: "steer" | "queue",
): Promise<void> {
  if (busy.has(sessionID)) {
    pendingStart.add(sessionID)
    return
  }
  // Close the window before `execution.started` arrives: a second command must
  // not inject another round into the execution this one just woke.
  busy.add(sessionID)
  try {
    const result = await startRound(ctx, sessionID, goal, delivery)
    if (!result.started) busy.delete(sessionID)
  } catch (error) {
    busy.delete(sessionID)
    throw error
  }
}

async function executeGl(
  ctx: any,
  sessionID: string,
  rawInput: string,
  delivery: "steer" | "queue",
): Promise<void> {
  const command = parseGl(rawInput)
  const current = await readGoal(ctx, sessionID)

  switch (command.kind) {
    case "show": {
      // OpenCode commands have no success-output channel; a thrown message is
      // the only UI-only output and stays out of model history, like DSH.
      if (current === undefined) throw new Error(`No goal is currently set.\n${USAGE}`)
      throw new Error(renderGoal("Goal", current, sessionID))
    }
    case "invalid-edit":
      throw new Error(`Goal editing requires a replacement objective.\n${USAGE}`)
    case "create": {
      if (current !== undefined && current.phase !== "complete")
        throw new Error(
          `A goal is already ${phaseLabel(current.phase)}. Use /gl edit <objective> to change it or /gl clear before replacing it.`,
        )
      const created = await createGoal(ctx, sessionID, command.objective)
      await startFromCommand(ctx, sessionID, created, delivery)
      return
    }
    case "edit": {
      if (current === undefined)
        throw new Error(`No goal is currently set; /gl edit requires one. ${USAGE}`)
      const edited =
        current.phase === "complete"
          ? await createGoal(ctx, sessionID, command.objective)
          : await editGoal(ctx, sessionID, goalRef(current.id, current.revision), command.objective, undefined)
      if (edited.phase === "active" && armed.has(sessionID))
        await startFromCommand(ctx, sessionID, edited, delivery)
      return
    }
    case "pause": {
      if (current === undefined) throw new Error(`No goal is currently set; /gl pause requires one. ${USAGE}`)
      const paused = await pauseGoal(ctx, sessionID, goalRef(current.id, current.revision))
      try {
        await ctx.session.interrupt({ sessionID, resume: false })
      } catch {}
      throw new Error(renderGoal("Goal paused", paused, sessionID))
    }
    case "resume": {
      if (current === undefined) throw new Error(`No goal is currently set; /gl resume requires one. ${USAGE}`)
      const resumed = await resumeGoal(ctx, sessionID, goalRef(current.id, current.revision))
      await startFromCommand(ctx, sessionID, resumed, delivery)
      return
    }
    case "clear": {
      if (current === undefined) {
        const raw = await ctx.storage.get(STORAGE_PREFIX + sessionID)
        if (raw === undefined) throw new Error("No goal to clear.")
        await removeGoal(ctx, sessionID)
        throw new Error("Corrupt goal state cleared.")
      }
      await clearGoal(ctx, sessionID, goalRef(current.id, current.revision))
      throw new Error("Goal cleared.")
    }
  }
}

// ---------------------------------------------------------------------------
// Model guidance (DSH tool:goal system prompt section)
// ---------------------------------------------------------------------------

function guidance(): string {
  return `create_goal may infer goal intent from a direct human request in any language. After a server restart, an active goal is disarmed: when a human asks to continue or resume in any wording or language, use update_goal action resume to rearm it. Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists for at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked.`
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const GoalLitePlugin = {
  id: "goal-lite",

  async setup(ctx: any) {
    const rpc = await ctx.rpc.register(GoalLite, {
      get: async (input: any) => {
        const goal = await readGoal(ctx, input.sessionID)
        return goal === undefined ? null : publicGoal(goal, input.sessionID)
      },
      pause: async (input: any) =>
        serialize(input.sessionID, async () => {
          const current = await readGoal(ctx, input.sessionID)
          if (current === undefined) return null
          const paused = await pauseGoal(ctx, input.sessionID, goalRef(current.id, current.revision))
          try {
            await ctx.session.interrupt({ sessionID: input.sessionID, resume: false })
          } catch {}
          return publicGoal(paused, input.sessionID)
        }),
      resume: async (input: any) =>
        serialize(input.sessionID, async () => {
          const current = await readGoal(ctx, input.sessionID)
          if (current === undefined) return null
          const resumed = await resumeGoal(ctx, input.sessionID, goalRef(current.id, current.revision))
          await startFromCommand(ctx, input.sessionID, resumed, "steer")
          return publicGoal(resumed, input.sessionID)
        }),
      clear: async (input: any) =>
        serialize(input.sessionID, async () => {
          const current = await readGoal(ctx, input.sessionID)
          if (current === undefined) {
            const raw = await ctx.storage.get(STORAGE_PREFIX + input.sessionID)
            if (raw !== undefined) await removeGoal(ctx, input.sessionID)
            return null
          }
          await clearGoal(ctx, input.sessionID, goalRef(current.id, current.revision))
          return null
        }),
    })

    notifyGoalChanged = (sessionID, goal) => {
      void rpc.events
        .emit("changed", { sessionID, goal: goal === undefined ? null : publicGoal(goal, sessionID) })
        .catch((error: unknown) => console.error("[goal-lite] failed to publish goal change", error))
    }

    // Replay the model-facing policy only while a goal exists. The text is
    // stable, so it appends as one cached system part.
    await ctx.session.hook("context", async (event: any) => {
      try {
        const goal = await readGoal(ctx, event.sessionID)
        if (goal === undefined || goal.phase === "complete") return
        const text = guidance()
        if (event.system.some((part: any) => part?.type === "text" && part.text === text)) return
        event.system.push({ type: "text", text })
      } catch (error) {
        console.error("[goal-lite] failed to inject goal guidance", error)
      }
    })

    await ctx.session.hook("experimental.idle", async (event: any) => {
      try {
        const background = event.background ?? []
        await serialize(event.sessionID, async () => {
          const started = await drive(ctx, event.sessionID, background)
          // The hook has now observed this session: it either started the
          // round or deferred for background work, so a deferred command no
          // longer needs the settle fallback.
          if (started || background.length > 0) pendingStart.delete(event.sessionID)
          return started
        })
      } catch (error) {
        console.error("[goal-lite] goal continuation failed", error)
        // DSH disarms a driver that fails; the durable phase is untouched.
        armed.delete(event.sessionID)
      }
    })

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "get_goal",
        description:
          "Read the current session goal, including the id and revision that update_goal requires.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input: unknown, context: any) => {
          const goal = await readGoal(ctx, context.sessionID)
          return { content: JSON.stringify(goalValue(goal, context.sessionID)) }
        },
      })

      editor.add({
        name: "create_goal",
        description:
          'Create a persisted goal that keeps this session working across automatic continuation rounds. Use it when the direct human request is a long-running objective, even if the user did not say "goal"; not for single-turn work.',
        input: {
          type: "object",
          properties: {
            objective: {
              type: "string",
              description: "The concrete completion objective inferred from the direct human request.",
            },
            max_goal_rounds: {
              type: "number",
              description: "Optional positive safe-integer limit on automatic continuation rounds.",
            },
          },
          required: ["objective"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) =>
          serialize(context.sessionID, async () => {
            requireDirectHuman(await turnAuthority(ctx, context))
            const goal = await createGoal(ctx, context.sessionID, input.objective, input.max_goal_rounds)
            return { content: JSON.stringify(goalValue(goal, context.sessionID)) }
          }),
      })

      editor.add({
        name: "update_goal",
        description: "Update the current goal.",
        input: {
          type: "object",
          properties: {
            goal_id: { type: "string", description: "Exact id returned by get_goal." },
            revision: {
              type: "number",
              description: "Exact positive revision returned by get_goal.",
            },
            action: {
              type: "string",
              enum: ["edit", "pause", "resume", "complete", "blocked"],
              description:
                "edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.",
            },
            objective: {
              type: "string",
              description: "Replacement objective; valid only with action edit.",
            },
            max_goal_rounds: {
              type: "number",
              description: "Replacement cap; valid only with action edit.",
            },
            blocked_reason: {
              type: "string",
              description:
                "Required only with action blocked: the concrete condition that persisted across rounds and blocks progress.",
            },
          },
          required: ["goal_id", "revision", "action"],
          additionalProperties: false,
        },
        execute: async (input: any, context: any) =>
          serialize(context.sessionID, async () => {
          const authority = await turnAuthority(ctx, context)
          const ref = goalRef(input.goal_id, input.revision)
          const sessionID: string = context.sessionID

          if (input.action === "edit") {
            requireDirectHuman(authority)
            if (hasText(input.blocked_reason))
              fail("blocked_reason is valid only with action blocked", "GOAL_TOOL_INVALID_UPDATE")
            const goal = await editGoal(ctx, sessionID, ref, input.objective, input.max_goal_rounds)
            return { content: JSON.stringify(goalValue(goal, sessionID)) }
          }

          if (input.action === "pause" || input.action === "resume") {
            requireDirectHuman(authority)
            if (hasText(input.objective) || hasRoundCap(input.max_goal_rounds) || hasText(input.blocked_reason))
              fail(
                "objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked",
                "GOAL_TOOL_INVALID_UPDATE",
              )
            const current = authority.goal
            if (
              input.action === "resume" &&
              current !== undefined &&
              current.id === ref.id &&
              current.revision === ref.revision &&
              current.phase === "paused"
            )
              fail(
                "the model cannot resume a paused goal; the user must resume it",
                "GOAL_TOOL_RESUME_PAUSED",
              )
            const goal =
              input.action === "pause"
                ? await pauseGoal(ctx, sessionID, ref)
                : await resumeGoal(ctx, sessionID, ref)
            return { content: JSON.stringify(goalValue(goal, sessionID)) }
          }

          const grant = completionAuthority(authority)
          if (hasText(input.objective) || hasRoundCap(input.max_goal_rounds))
            fail(
              "objective and max_goal_rounds are valid only with action edit",
              "GOAL_TOOL_INVALID_UPDATE",
            )
          if (input.action === "complete" && hasText(input.blocked_reason))
            fail("blocked_reason is valid only with action blocked", "GOAL_TOOL_INVALID_UPDATE")
          if (
            input.action === "blocked" &&
            (input.blocked_reason === undefined || input.blocked_reason.trim().length === 0)
          )
            fail("blocked_reason is required with action blocked", "GOAL_TOOL_INVALID_UPDATE")
          if (
            input.action === "blocked" &&
            grant === "goal-round" &&
            (authority.goal?.roundsStarted ?? 0) < BLOCKED_AFTER_CONSECUTIVE_ROUNDS
          )
            fail(
              `blocked requires at least ${BLOCKED_AFTER_CONSECUTIVE_ROUNDS} consecutive goal rounds; current round is ${authority.goal?.roundsStarted ?? 0}`,
              "GOAL_TOOL_BLOCK_THRESHOLD",
            )

          const goal =
            input.action === "complete"
              ? await completeGoal(ctx, sessionID, ref)
              : await blockGoal(ctx, sessionID, ref, {
                  code: "model-reported",
                  message: input.blocked_reason,
                })
          return { content: JSON.stringify(goalValue(goal, sessionID)) }
          }),
      })
    })

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "gl",
        description: "Set or view the goal for a long-running task [pause|resume|clear]",
        execute: async (input: any) => {
          await serialize(input.sessionID, () =>
            executeGl(ctx, input.sessionID, input.prompt?.text ?? "", input.delivery),
          )
        },
      })
    })

    // Pause on user abort or execution failure, and drop goals of deleted
    // sessions. A server shutdown keeps the goal active; the next process
    // starts disarmed, exactly like a DSH process restart.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.execution.started",
            "session.execution.succeeded",
            "session.execution.failed",
            "session.execution.interrupted",
            "session.deleted",
          ],
          signal: controller.signal,
        })) {
          const sessionID: string | undefined = event.data?.sessionID
          if (sessionID === undefined) continue
          try {
            if (event.type === "session.execution.started") {
              busy.add(sessionID)
              continue
            }
            if (event.type === "session.execution.succeeded") {
              busy.delete(sessionID)
              activeRounds.delete(sessionID)
              if (!pendingStart.delete(sessionID)) continue
              // A command created/resumed/edited the goal after the idle hook
              // already returned: start the deferred round now.
              await serialize(sessionID, async () => {
                const session = await ctx.session.get({ sessionID })
                if (session?.parentID !== undefined) return
                const goal = await readGoal(ctx, sessionID)
                if (goal === undefined || goal.phase !== "active" || !armed.has(sessionID)) return
                busy.add(sessionID)
                try {
                  const result = await startRound(ctx, sessionID, goal)
                  if (!result.started) busy.delete(sessionID)
                } catch (error) {
                  busy.delete(sessionID)
                  throw error
                }
              })
              continue
            }
            if (event.type === "session.execution.interrupted" && event.data?.reason === "superseded") {
              // A successor execution takes over from the interrupted one. Keep
              // busy, the admitted round, and any deferred start: clearing them
              // here opens a window where a command can inject a round into the
              // successor. The successor's started/succeeded events own cleanup.
              continue
            }
            if (event.type === "session.deleted") {
              busy.delete(sessionID)
              pendingStart.delete(sessionID)
              await serialize(sessionID, () => removeGoal(ctx, sessionID))
              continue
            }
            // DSH disarms a driver that hit an execution error but keeps the
            // durable phase: the next human request must rearm it.
            if (event.type === "session.execution.failed") {
              busy.delete(sessionID)
              activeRounds.delete(sessionID)
              pendingStart.delete(sessionID)
              armed.delete(sessionID)
              const goal = await readGoal(ctx, sessionID)
              if (goal !== undefined) notifyGoalChanged?.(sessionID, goal)
              continue
            }
            busy.delete(sessionID)
            activeRounds.delete(sessionID)
            pendingStart.delete(sessionID)
            if (event.data?.reason !== "user") continue
            await serialize(sessionID, async () => {
              const goal = await readGoal(ctx, sessionID)
              if (goal === undefined || goal.phase !== "active") return
              await pauseGoal(ctx, sessionID, goalRef(goal.id, goal.revision))
            })
          } catch (error) {
            console.error("[goal-lite] failed to handle session event", event.type, error)
          }
        }
      } catch (error: any) {
        if (error?.name !== "AbortError") console.error("[goal-lite] event subscription ended", error)
      }
    })()

    const tools = await ctx.tool.list()
    const names = tools.map((tool: any) => tool.id).filter((id: string) => id.includes("goal"))
    console.log(`[goal-lite] loaded (tools: ${names.join(", ") || "none"})`)

    return () => {
      controller.abort()
      // DSH disarms a driver before unloading it; a later human request must
      // rearm the goal explicitly.
      notifyGoalChanged = undefined
      armed.clear()
      busy.clear()
      pendingStart.clear()
      activeRounds.clear()
    }
  },
}

export default GoalLitePlugin
