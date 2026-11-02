// Semantic tests for goal-lite. Runs without a model or an OpenCode server.
//   node test.mjs
import assert from "node:assert/strict"
import plugin from "./index.ts"

function makeEnv(sessionID) {
  const storage = new Map()
  const tools = new Map()
  const commands = new Map()
  const hooks = {}
  const messages = []
  const synthetic = []
  let parentID
  let interrupts = 0
  const eventQueue = []
  let eventWake = null
  let gate = null
  let rpcHandlers = {}
  const rpcEvents = []

  const ctx = {
    storage: {
      async get(key) {
        return storage.get(key)
      },
      async set(key, value) {
        // Hold the round reservation so a concurrent pause can land first.
        if (gate !== null && value?.phase === "active" && value?.roundsStarted === 1 && value?.revision === 1) {
          gate.entered()
          await gate.promise
        }
        storage.set(key, structuredClone(value))
      },
      async remove(key) {
        storage.delete(key)
      },
      async scan() {
        return { entries: [] }
      },
    },
    session: {
      async get() {
        return { id: sessionID, parentID }
      },
      async context() {
        return messages
      },
      async synthetic(input) {
        synthetic.push(input)
        messages.push({ type: "synthetic", text: input.text, metadata: input.metadata })
      },
      async interrupt() {
        interrupts += 1
        return { interrupted: true }
      },
      async hook(name, callback) {
        hooks[name] = callback
        return { dispose: async () => {} }
      },
    },
    tool: {
      async transform(callback) {
        callback({ add: (tool) => tools.set(tool.name, tool) })
        return { dispose: async () => {} }
      },
      async list() {
        return [...tools.values()].map((tool) => ({ id: tool.name }))
      },
    },
    command: {
      async transform(callback) {
        callback({ add: (command) => commands.set(command.name, command) })
        return { dispose: async () => {} }
      },
    },
    rpc: {
      async register(_definition, handlers) {
        rpcHandlers = handlers
        return {
          dispose: async () => {},
          events: {
            async emit(name, data) {
              rpcEvents.push({ name, data })
            },
          },
        }
      },
    },
    event: {
      subscribe() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (eventQueue.length > 0) return Promise.resolve({ value: eventQueue.shift(), done: false })
                return new Promise((resolve) => {
                  eventWake = resolve
                })
              },
              return() {
                return Promise.resolve({ value: undefined, done: true })
              },
            }
          },
        }
      },
    },
  }

  return {
    ctx,
    sessionID,
    storage,
    tools,
    commands,
    hooks,
    messages,
    synthetic,
    setParent: (value) => (parentID = value),
    interrupts: () => interrupts,
    holdRoundWrite() {
      let enter
      const entered = new Promise((resolve) => (enter = resolve))
      let release
      const promise = new Promise((resolve) => (release = resolve))
      gate = { entered: enter, promise }
      return {
        entered,
        release() {
          gate = null
          release()
        },
      }
    },
    emit(event) {
      if (eventWake !== null) {
        const wake = eventWake
        eventWake = null
        wake({ value: event, done: false })
      } else {
        eventQueue.push(event)
      }
    },
    turn(...items) {
      messages.length = 0
      messages.push(...items)
    },
    async tool(name, input) {
      try {
        const result = await tools.get(name).execute(input, { sessionID })
        return { ok: true, value: JSON.parse(result.content) }
      } catch (error) {
        return { ok: false, error: String(error.message) }
      }
    },
    async command(text) {
      try {
        await commands.get("gl").execute({ sessionID, prompt: { text }, delivery: "steer" })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error.message) }
      }
    },
    async rpc(name, input) {
      try {
        const handler = rpcHandlers[name]
        if (handler === undefined) throw new Error(`no rpc handler: ${name}`)
        return { ok: true, value: await handler(input, {}) }
      } catch (error) {
        return { ok: false, error: String(error.message) }
      }
    },
    rpcEvents,
    get goal() {
      return storage.get("session:" + sessionID)
    },
  }
}

async function fresh(id) {
  const env = makeEnv(id)
  await plugin.setup(env.ctx)
  return env
}

function human(env) {
  env.turn({ type: "user", text: "please do the thing", time: { created: Date.now() } })
}

function goalRound(env) {
  const last = env.synthetic.at(-1)
  env.turn({ type: "idle" }, { type: "synthetic", text: last.text, metadata: last.metadata })
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// --- create / get -----------------------------------------------------------

test("get_goal with no goal returns goal:null", async () => {
  const env = await fresh("ses_t01")
  const result = await env.tool("get_goal", {})
  assert.deepEqual(result.value, { goal: null })
})

test("create_goal requires a direct human turn", async () => {
  const env = await fresh("ses_t02")
  env.turn({ type: "idle" }, { type: "synthetic", text: "x" })
  const result = await env.tool("create_goal", { objective: "ship it" })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_TOOL_AUTHORITY_REQUIRED/)
})

test("create_goal from a human turn arms revision 1", async () => {
  const env = await fresh("ses_t03")
  human(env)
  const result = await env.tool("create_goal", { objective: "  ship it  " })
  assert.equal(result.ok, true)
  assert.equal(result.value.activation, "armed")
  assert.deepEqual(result.value.goal, {
    id: result.value.goal.id,
    revision: 1,
    objective: "ship it",
    phase: "active",
    roundsStarted: 0,
    maxGoalRounds: 50,
  })
  assert.equal(Object.hasOwn(result.value.goal, "acceptance_criteria"), false)
})

test("create_goal rejects a second live goal", async () => {
  const env = await fresh("ses_t04")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  const result = await env.tool("create_goal", { objective: "two" })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_ALREADY_EXISTS/)
})

test("create_goal rejects an invalid round cap", async () => {
  const env = await fresh("ses_t05")
  human(env)
  for (const cap of [0, -1, 1.5]) {
    const result = await env.tool("create_goal", { objective: "one", max_goal_rounds: cap })
    assert.equal(result.ok, false)
    assert.match(result.error, /GOAL_INVALID_MAX_ROUNDS/)
  }
})

test("create_goal rejects an empty objective", async () => {
  const env = await fresh("ses_t06")
  human(env)
  const result = await env.tool("create_goal", { objective: "   " })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_INVALID_OBJECTIVE/)
})

test("create_goal rejects a subagent session", async () => {
  const env = await fresh("ses_t07")
  human(env)
  env.setParent("ses_parent")
  const result = await env.tool("create_goal", { objective: "one" })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_TOOL_AUTHORITY_REQUIRED/)
})

// --- edit / CAS -------------------------------------------------------------

test("update_goal rejects a stale revision", async () => {
  const env = await fresh("ses_t08")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 99,
    action: "edit",
    objective: "two",
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_STALE_REVISION/)
})

test("update_goal edit keeps phase and activation and bumps revision", async () => {
  const env = await fresh("ses_t09")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "edit",
    objective: "two",
    max_goal_rounds: 7,
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.goal.revision, 2)
  assert.equal(result.value.goal.objective, "two")
  assert.equal(result.value.goal.maxGoalRounds, 7)
  assert.equal(result.value.goal.phase, "active")
  assert.equal(result.value.activation, "armed")
})

test("update_goal edit requires a human turn", async () => {
  const env = await fresh("ses_t10")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  env.turn({ type: "idle" }, { type: "synthetic", text: "x" })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "edit",
    objective: "two",
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_TOOL_AUTHORITY_REQUIRED/)
})

// --- pause / resume ---------------------------------------------------------

test("the model cannot resume a durable paused goal", async () => {
  const env = await fresh("ses_t11")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  const paused = await env.command("pause")
  assert.equal(paused.ok, false)
  assert.match(paused.error, /Goal paused/)
  assert.equal(env.goal.phase, "paused")
  assert.equal(env.goal.revision, 2)

  human(env)
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: env.goal.revision,
    action: "resume",
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_TOOL_RESUME_PAUSED/)
})

test("/gl resume arms a paused goal and starts the next round", async () => {
  const env = await fresh("ses_t12")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  await env.command("pause")
  const resumed = await env.command("resume")
  assert.equal(resumed.ok, true)
  assert.equal(env.goal.phase, "active")
  assert.equal(env.goal.revision, 3)
  assert.equal(env.synthetic.at(-1).metadata.round, 1)
  assert.equal(env.goal.roundsStarted, 1)
  const shown = await env.command("")
  assert.match(shown.error, /Rounds: 1\/50/)
  assert.match(shown.error, /Activation: armed/)
})

test("update_goal resume rejects an already armed active goal", async () => {
  const env = await fresh("ses_t13")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  human(env)
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "resume",
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_INVALID_TRANSITION/)
})

// --- rounds -----------------------------------------------------------------

test("idle driver starts rounds and does not bump revision", async () => {
  const env = await fresh("ses_t14")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  assert.equal(env.synthetic.length, 1)
  const message = env.synthetic[0]
  assert.match(message.text, /^<goal_round>/)
  assert.match(message.text, /Round: 1\/50/)
  assert.deepEqual(message.metadata, {
    source: "goal-lite",
    goalID: created.value.goal.id,
    revision: 1,
    round: 1,
  })
  assert.equal(env.goal.roundsStarted, 1)
  assert.equal(env.goal.revision, 1)
})

test("idle driver does nothing while disarmed", async () => {
  const env = await fresh("ses_t15")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  await env.command("pause")
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  assert.equal(env.synthetic.length, 0)
})

test("idle driver waits for a running subagent", async () => {
  const env = await fresh("ses_t16")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({
    sessionID: env.sessionID,
    background: [{ kind: "subagent", sessionID: env.sessionID, childSessionID: "ses_child" }],
  })
  assert.equal(env.synthetic.length, 0)
})

test("round exhaustion blocks with round-limit", async () => {
  const env = await fresh("ses_t17")
  human(env)
  const created = await env.tool("create_goal", { objective: "one", max_goal_rounds: 1 })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  assert.equal(env.goal.roundsStarted, 1)
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  assert.equal(env.synthetic.length, 1)
  assert.equal(env.goal.phase, "blocked")
  assert.deepEqual(env.goal.blockedReason, {
    code: "round-limit",
    message: "Goal reached its configured limit of 1 rounds.",
  })
  assert.equal(env.goal.revision, 2)
})

test("complete is allowed inside the exact goal round", async () => {
  const env = await fresh("ses_t18")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  goalRound(env)
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "complete",
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.goal.phase, "complete")
  assert.equal(result.value.activation, "disarmed")
})

test("complete is rejected in an unrelated synthetic turn", async () => {
  const env = await fresh("ses_t19")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  env.turn({ type: "idle" }, { type: "synthetic", text: "notice" })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "complete",
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_TOOL_AUTHORITY_REQUIRED/)
})

test("blocked is rejected before three goal rounds", async () => {
  const env = await fresh("ses_t20")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  goalRound(env)
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "blocked",
    blocked_reason: "waiting on credentials",
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_TOOL_BLOCK_THRESHOLD/)
})

test("blocked never applies to complete goals and requires a reason", async () => {
  const env = await fresh("ses_t21")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  human(env)
  const missing = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "blocked",
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /GOAL_TOOL_INVALID_UPDATE/)

  human(env)
  const blocked = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "blocked",
    blocked_reason: "waiting on credentials",
  })
  assert.equal(blocked.ok, true)
  assert.deepEqual(blocked.value.goal.blockedReason, {
    code: "model-reported",
    message: "waiting on credentials",
  })
  assert.equal(blocked.value.activation, "disarmed")

  human(env)
  const complete = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 2,
    action: "complete",
  })
  assert.equal(complete.ok, true)
  assert.deepEqual(complete.value.goal.blockedReason, undefined)
})

// --- command grammar --------------------------------------------------------

test("/gl clears and /gl create replaces a complete goal", async () => {
  const env = await fresh("ses_t22")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  const clear = await env.command("clear")
  assert.equal(clear.ok, false)
  assert.match(clear.error, /Goal cleared\./)
  assert.equal(env.goal, undefined)

  human(env)
  await env.tool("create_goal", { objective: "one" })
  human(env)
  const created = await env.tool("update_goal", {
    goal_id: env.goal.id,
    revision: 1,
    action: "complete",
  })
  assert.equal(created.ok, true)
  const replaced = await env.command("two")
  assert.equal(replaced.ok, true)
  assert.equal(env.goal.objective, "two")
  assert.equal(env.goal.phase, "active")
})

test("/gl pause interrupts the running turn", async () => {
  const env = await fresh("ses_t23")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  await env.command("pause")
  assert.equal(env.interrupts(), 1)
})

test("unknown /gl text is an objective; edit without text is invalid", async () => {
  const env = await fresh("ses_t24")
  human(env)
  const invalid = await env.command("edit")
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /requires a replacement objective/)

  const created = await env.command("Pause everything now")
  assert.equal(created.ok, true)
  assert.equal(env.goal.objective, "Pause everything now")
})

// --- lifecycle events -------------------------------------------------------

test("execution failure disarms but keeps the durable phase", async () => {
  const env = await fresh("ses_t25")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  env.emit({
    type: "session.execution.failed",
    data: { sessionID: env.sessionID, error: { message: "provider failed" } },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(env.goal.phase, "active")
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  assert.equal(env.synthetic.length, 0)
})

test("a user interrupt pauses the active goal", async () => {
  const env = await fresh("ses_t26")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  env.emit({
    type: "session.execution.interrupted",
    data: { sessionID: env.sessionID, reason: "user" },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(env.goal.phase, "paused")
  assert.equal(env.goal.revision, 2)
})

test("a deleted session drops its goal", async () => {
  const env = await fresh("ses_t27")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  env.emit({ type: "session.deleted", data: { sessionID: env.sessionID } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(env.goal, undefined)
})

// --- regression: races, authority, deferral --------------------------------

test("a pause that races an idle round cannot be overwritten", async () => {
  const env = await fresh("ses_t28")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  const hold = env.holdRoundWrite()
  const idle = env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  await hold.entered
  const pause = env.command("pause")
  await new Promise((resolve) => setTimeout(resolve, 0))
  hold.release()
  await Promise.all([idle, pause])
  assert.equal(env.goal.phase, "paused")
  assert.equal(env.goal.revision, 2)
  assert.equal(env.goal.roundsStarted, 1)
})

test("edit during an auto round requires a direct human", async () => {
  const env = await fresh("ses_t29")
  env.turn({ type: "idle" }, { type: "user", text: "start", time: { created: Date.now() } })
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "edit",
    objective: "two",
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_TOOL_AUTHORITY_REQUIRED/)
})

test("complete inside a real auto round works", async () => {
  const env = await fresh("ses_t30")
  env.turn({ type: "idle" }, { type: "user", text: "start", time: { created: Date.now() } })
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "complete",
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.goal.phase, "complete")
})

test("complete still works after a compaction removes the round message", async () => {
  const env = await fresh("ses_t31")
  env.turn({ type: "idle" }, { type: "user", text: "start", time: { created: Date.now() } })
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  env.turn({ type: "compaction", status: "completed", summary: "..." }, { type: "assistant", content: [] })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "complete",
  })
  assert.equal(result.ok, true)
})

test("a human steer after the round grants direct human authority", async () => {
  const env = await fresh("ses_t32")
  env.turn({ type: "idle" }, { type: "user", text: "start", time: { created: Date.now() } })
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  env.messages.push({ type: "user", text: "change the objective", time: { created: Date.now() + 1_000 } })
  const result = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "edit",
    objective: "two",
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.goal.objective, "two")
})

test("idle driver waits for a running shell", async () => {
  const env = await fresh("ses_t33")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({
    sessionID: env.sessionID,
    background: [{ kind: "shell", sessionID: env.sessionID, shellID: "sh_1", command: "sleep 1" }],
  })
  assert.equal(env.synthetic.length, 0)
})

test("/gl defers its first round while the session is busy", async () => {
  const env = await fresh("ses_t34")
  human(env)
  env.emit({ type: "session.execution.started", data: { sessionID: env.sessionID } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const created = await env.command("new objective")
  assert.equal(created.ok, true)
  assert.equal(env.goal.phase, "active")
  assert.equal(env.synthetic.length, 0)
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  assert.equal(env.synthetic.length, 1)
  env.emit({ type: "session.execution.succeeded", data: { sessionID: env.sessionID } })
  await new Promise((resolve) => setTimeout(resolve, 10))
})

test("/gl starts a deferred round when the turn settles", async () => {
  const env = await fresh("ses_t38")
  human(env)
  env.emit({ type: "session.execution.started", data: { sessionID: env.sessionID } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await env.command("new objective")
  assert.equal(env.synthetic.length, 0)
  env.emit({ type: "session.execution.succeeded", data: { sessionID: env.sessionID } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(env.synthetic.length, 1)
  assert.equal(env.goal.roundsStarted, 1)
})

test("goals longer than the objective cap are rejected", async () => {
  const env = await fresh("ses_t35")
  human(env)
  const result = await env.tool("create_goal", { objective: "x".repeat(4001) })
  assert.equal(result.ok, false)
  assert.match(result.error, /GOAL_INVALID_OBJECTIVE/)
})

test("/gl clear removes a corrupt goal record", async () => {
  const env = await fresh("ses_t36")
  env.storage.set("session:" + env.sessionID, { broken: true })
  const result = await env.command("clear")
  assert.equal(result.ok, false)
  assert.match(result.error, /Corrupt goal state cleared/)
  assert.equal(env.goal, undefined)
})

test("guidance is not injected for a complete goal", async () => {
  const env = await fresh("ses_t37")
  human(env)
  const created = await env.tool("create_goal", { objective: "one" })
  const before = { sessionID: env.sessionID, system: [] }
  await env.hooks["context"](before)
  assert.equal(before.system.length, 1)
  human(env)
  await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "complete",
  })
  const after = { sessionID: env.sessionID, system: [] }
  await env.hooks["context"](after)
  assert.equal(after.system.length, 0)
})

test("a human steer after compaction grants edit and pause", async () => {
  const env = await fresh("ses_t39")
  const t0 = Date.now()
  env.turn({ type: "idle" }, { type: "user", text: "start", time: { created: t0 } })
  const created = await env.tool("create_goal", { objective: "one" })
  await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
  const steerAt = Date.now() + 1_000
  env.turn(
    { type: "compaction", status: "completed", summary: "..." },
    { type: "assistant", content: [], time: { created: t0 + 10 } },
    { type: "user", text: "change the objective", time: { created: steerAt } },
  )
  const edited = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 1,
    action: "edit",
    objective: "two",
  })
  assert.equal(edited.ok, true)
  assert.equal(edited.value.goal.objective, "two")
  const paused = await env.tool("update_goal", {
    goal_id: created.value.goal.id,
    revision: 2,
    action: "pause",
  })
  assert.equal(paused.ok, true)
  assert.equal(paused.value.goal.phase, "paused")
})

test("rpc get/pause/resume/clear drives the TUI sidebar", async () => {
  const env = await fresh("ses_t40")
  human(env)
  assert.deepEqual((await env.rpc("get", { sessionID: env.sessionID })).value, null)

  const created = await env.tool("create_goal", { objective: "one" })
  assert.equal(created.ok, true)
  const got = await env.rpc("get", { sessionID: env.sessionID })
  assert.equal(got.ok, true)
  assert.equal(got.value.objective, "one")
  assert.equal(got.value.activation, "armed")
  const createdEvent = env.rpcEvents.find(
    (event) => event.name === "changed" && event.data.goal?.objective === "one",
  )
  assert.equal(createdEvent.data.goal.activation, "armed")

  const paused = await env.rpc("pause", { sessionID: env.sessionID })
  assert.equal(paused.ok, true)
  assert.equal(paused.value.phase, "paused")
  assert.equal(paused.value.activation, "disarmed")
  const pausedEvent = env.rpcEvents.find(
    (event) => event.name === "changed" && event.data.goal?.phase === "paused",
  )
  assert.equal(pausedEvent.data.goal.activation, "disarmed")

  const resumed = await env.rpc("resume", { sessionID: env.sessionID })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.value.phase, "active")
  assert.equal(env.synthetic.length, 1)
  const resumedEvent = env.rpcEvents.findLast(
    (event) => event.name === "changed" && event.data.goal?.phase === "active",
  )
  assert.equal(resumedEvent.data.goal.activation, "armed")

  const cleared = await env.rpc("clear", { sessionID: env.sessionID })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.value, null)
  assert.equal(env.goal, undefined)
  assert.ok(env.rpcEvents.some((event) => event.name === "changed" && event.data.goal === null))
})

test("a superseded execution keeps a command round deferred during the handoff", async () => {
  const env = await fresh("ses_t41")
  human(env)
  await env.tool("create_goal", { objective: "one" })
  env.emit({ type: "session.execution.started", data: { sessionID: env.sessionID } })
  env.emit({ type: "session.execution.started", data: { sessionID: env.sessionID } })
  env.emit({
    type: "session.execution.interrupted",
    data: { sessionID: env.sessionID, reason: "superseded" },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const edited = await env.command("edit two")
  assert.equal(edited.ok, true)
  assert.equal(env.goal.objective, "two")
  assert.equal(env.synthetic.length, 0)

  env.emit({ type: "session.execution.succeeded", data: { sessionID: env.sessionID } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(env.synthetic.length, 1)
  assert.equal(env.goal.roundsStarted, 1)
})

test("a deferred command waits for background shells, subagents, and images", async () => {
  const background = [
    {
      name: "shell",
      message: { type: "shell", shellID: "sh_1", command: "sleep 1", status: "running" },
      complete() {
        this.message.status = "exited"
      },
    },
    {
      name: "subagent",
      message: {
        type: "assistant",
        content: [
          { type: "tool", id: "tool_1", name: "subagent", state: { status: "running" } },
        ],
      },
      complete() {
        this.message.content[0].state = { status: "completed" }
      },
    },
    {
      name: "image",
      message: {
        type: "assistant",
        content: [{ type: "tool", id: "tool_2", name: "image", state: { status: "running" } }],
      },
      complete() {
        this.message.content[0].state = { status: "completed" }
      },
    },
  ]

  for (const [index, item] of background.entries()) {
    const env = await fresh(`ses_t42_${index}`)
    human(env)
    env.emit({ type: "session.execution.started", data: { sessionID: env.sessionID } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await env.command("new objective")
    assert.equal(env.synthetic.length, 0, `${item.name}: the command must defer first`)

    env.messages.push(item.message)
    env.emit({ type: "session.execution.succeeded", data: { sessionID: env.sessionID } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(env.synthetic.length, 0, `${item.name}: the settle fallback must not inject a round`)

    item.complete()
    await env.hooks["experimental.idle"]({ sessionID: env.sessionID, background: [] })
    assert.equal(env.synthetic.length, 1, `${item.name}: the idle driver must start after completion`)
    assert.equal(env.goal.roundsStarted, 1)
  }
})

// --- run --------------------------------------------------------------------

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}`)
    console.error(error)
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed > 0) process.exitCode = 1
