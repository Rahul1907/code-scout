import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const pullRequestSchema = new Schema(
  {
    repoId: {
      type: Schema.Types.ObjectId,
      ref: "Repo",
      required: true,
      index: true,
    },
    runId: {
      type: String,
      required: true,
      index: true,
    },
    changesetId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    prNumber: {
      type: Number,
      required: true,
    },
    prUrl: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    headBranch: {
      type: String,
      required: true,
    },
    baseBranch: {
      type: String,
      required: true,
      default: "main",
    },
    status: {
      type: String,
      enum: ["open", "closed", "merged"],
      default: "open",
    },
  },
  { timestamps: true }
);

pullRequestSchema.index({ repoId: 1, prNumber: 1 }, { unique: true });

export type PullRequestFields = InferSchemaType<typeof pullRequestSchema>;
export type PullRequestDoc = PullRequestFields & { _id: mongoose.Types.ObjectId };

export const PullRequest: Model<PullRequestFields> =
  (mongoose.models.PullRequest as Model<PullRequestFields> | undefined) ??
  mongoose.model<PullRequestFields>("PullRequest", pullRequestSchema);
