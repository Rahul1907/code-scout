import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const conversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    repoId: { type: Schema.Types.ObjectId, ref: "Repo", required: true, index: true },
    title: { type: String, required: true, default: "New conversation" },
  },
  { timestamps: true },
);

conversationSchema.index({ userId: 1, repoId: 1, updatedAt: -1 });

export type ConversationFields = InferSchemaType<typeof conversationSchema>;

export const Conversation: Model<ConversationFields> =
  (mongoose.models.Conversation as Model<ConversationFields> | undefined) ??
  mongoose.model<ConversationFields>("Conversation", conversationSchema);

