import mongoose, { Document, Schema } from "mongoose";

export interface IEvalRun extends Document {
  _id: mongoose.Types.ObjectId;
  suite: "retrieval" | "task";
  createdAt: Date;
  configSnapshot: Record<string, any>;
  repos?: string[];
  totalQuestions?: number;
  totalTasks?: number;
  passedTasks?: number;
  failedTasks?: number;
  metrics: Record<string, any>;
  results?: any[];
}

const evalRunSchema = new Schema<IEvalRun>(
  {
    suite: { type: String, required: true, enum: ["retrieval", "task"] },
    createdAt: { type: Date, default: Date.now },
    configSnapshot: { type: Schema.Types.Mixed, default: {} },
    repos: [{ type: String }],
    totalQuestions: { type: Number },
    totalTasks: { type: Number },
    passedTasks: { type: Number },
    failedTasks: { type: Number },
    metrics: { type: Schema.Types.Mixed, default: {} },
    results: { type: [Schema.Types.Mixed], default: [] },
  },
  { collection: "eval_runs" }
);

evalRunSchema.index({ suite: 1, createdAt: -1 });

export const EvalRun = mongoose.model<IEvalRun>("EvalRun", evalRunSchema);

