import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const stepRecordSchema = new Schema(
  {
    index: { type: Number, required: true },
    type: { type: String, required: true },
    toolName: { type: String, default: undefined },
    inputSummary: { type: String, default: undefined },
    outputSummary: { type: String, default: undefined },
    durationMs: { type: Number, default: 0 },
    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
  },
  { _id: false },
);

const totalsSchema = new Schema(
  {
    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
    llmCalls: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },
  },
  { _id: false },
);

const agentRunSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    conversationId: { type: String, default: undefined },
    repoId: { type: String, required: true, index: true },
    userId: { type: String, default: undefined },
    mode: { type: String, enum: ["ask", "edit"], default: "ask" },
    status: {
      type: String,
      enum: ["running", "awaiting_approval", "completed", "failed", "cancelled"],
      default: "running",
    },
    steps: { type: [stepRecordSchema], default: [] },
    totals: { type: totalsSchema, default: () => ({}) },
    langfuseTraceId: { type: String, default: undefined },
    error: { type: String, default: undefined },
  },
  { timestamps: true, collection: "agent_runs" },
);

export type AgentRunFields = InferSchemaType<typeof agentRunSchema>;

export const AgentRun: Model<AgentRunFields> =
  (mongoose.models.AgentRun as Model<AgentRunFields> | undefined) ??
  mongoose.model<AgentRunFields>("AgentRun", agentRunSchema);

