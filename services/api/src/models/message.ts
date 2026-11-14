import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const citationSchema = new Schema(
  {
    filePath: { type: String, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
  },
  { _id: false },
);

const retrievedChunkSchema = new Schema(
  {
    chunkId: { type: String, default: undefined },
    filePath: { type: String, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
    score: { type: Number, required: true },
    source: {
      type: String,
      enum: ["vector", "keyword", "both", "unknown"],
      default: "unknown",
    },
    symbolName: { type: String, default: undefined },
    content: { type: String, default: undefined },
  },
  { _id: false },
);

const stepSchema = new Schema(
  {
    index: { type: Number, required: true },
    type: { type: String, required: true },
    toolName: { type: String, default: undefined },
    inputSummary: { type: String, default: undefined },
    outputSummary: { type: String, default: undefined },
    durationMs: { type: Number, default: 0 },
  },
  { _id: false },
);

const runSummarySchema = new Schema(
  {
    tokensIn: { type: Number, default: 0 },
    tokensOut: { type: Number, default: 0 },
    llmCalls: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    estimatedCostUsd: { type: Number, default: 0 },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    citations: { type: [citationSchema], default: [] },
    retrievedChunks: { type: [retrievedChunkSchema], default: [] },
    steps: { type: [stepSchema], default: [] },
    runSummary: { type: runSummarySchema, default: undefined },
    runId: { type: String, default: undefined },
    changesetId: { type: String, default: undefined },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });

export type MessageFields = InferSchemaType<typeof messageSchema>;

export const Message: Model<MessageFields> =
  (mongoose.models.Message as Model<MessageFields> | undefined) ??
  mongoose.model<MessageFields>("Message", messageSchema);

