import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const repoSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    owner: { type: String, required: true },
    name: { type: String, required: true },
    fullName: { type: String, required: true },
    defaultBranch: { type: String, required: true, default: "main" },
    commitSha: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "cloning", "indexing", "ready", "failed"],
      default: "pending",
      required: true,
    },
    progress: {
      stage: { type: String, default: "queued" },
      processedFiles: { type: Number, default: 0 },
      totalFiles: { type: Number, default: 0 },
    },
    stats: {
      files: { type: Number, default: 0 },
      chunks: { type: Number, default: 0 },
      languages: { type: Map, of: Number, default: {} },
    },
    githubInstallationId: { type: Number, default: null },
    error: { type: String, default: "" },
    indexedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

repoSchema.index({ userId: 1, fullName: 1 }, { unique: true });

export type RepoFields = InferSchemaType<typeof repoSchema>;
export type RepoDoc = RepoFields & { _id: mongoose.Types.ObjectId };

export const Repo: Model<RepoFields> =
  (mongoose.models.Repo as Model<RepoFields> | undefined) ??
  mongoose.model<RepoFields>("Repo", repoSchema);

