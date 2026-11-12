import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const citationSchema = new Schema(
  {
    filePath: { type: String, required: true },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
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
    runId: { type: String, default: undefined },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });

export type MessageFields = InferSchemaType<typeof messageSchema>;

export const Message: Model<MessageFields> =
  (mongoose.models.Message as Model<MessageFields> | undefined) ??
  mongoose.model<MessageFields>("Message", messageSchema);

