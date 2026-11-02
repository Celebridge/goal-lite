// A local plugin has no package.json, and `test.mjs` runs without OpenCode's
// runtime packages. `Rpc.define` is an identity helper plus a reserved-name
// check, so keep the definition dependency-free and structurally identical.
const define = <const T>(definition: T): T => definition

const blockedReason = {
  type: "object",
  properties: {
    code: { type: "string" },
    message: { type: "string" },
  },
  required: ["code", "message"],
  additionalProperties: false,
} as const

const goal = {
  type: "object",
  properties: {
    id: { type: "string" },
    revision: { type: "number" },
    objective: { type: "string" },
    phase: { type: "string", enum: ["active", "paused", "blocked", "complete"] },
    roundsStarted: { type: "number" },
    maxGoalRounds: { type: "number" },
    activation: { type: "string", enum: ["armed", "disarmed"] },
    blockedReason,
  },
  required: ["id", "revision", "objective", "phase", "roundsStarted", "maxGoalRounds", "activation"],
  additionalProperties: false,
} as const

const nullableGoal = {
  anyOf: [goal, { type: "null" }],
} as const

const sessionInput = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
  },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const changed = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    goal: nullableGoal,
  },
  required: ["sessionID", "goal"],
  additionalProperties: false,
} as const

/** The TUI reads a Session's goal through `get` and follows `changed` after every durable write. */
export const GoalLite = define({
  id: "goal-lite",
  methods: {
    get: {
      input: sessionInput,
      output: nullableGoal,
    },
    pause: {
      input: sessionInput,
      output: nullableGoal,
    },
    resume: {
      input: sessionInput,
      output: nullableGoal,
    },
    clear: {
      input: sessionInput,
      output: nullableGoal,
    },
  },
  events: {
    changed: {
      schema: changed,
    },
  },
})

export interface GoalPublic {
  id: string
  revision: number
  objective: string
  phase: "active" | "paused" | "blocked" | "complete"
  roundsStarted: number
  maxGoalRounds: number
  activation: "armed" | "disarmed"
  blockedReason?: {
    code: string
    message: string
  }
}
