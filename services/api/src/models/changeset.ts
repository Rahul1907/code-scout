import { Schema, model, Document } from "mongoose";

export interface IChangedFile {
  path: string;
  changeType: "added" | "modified" | "deleted";
  diff: string;
}

export interface ITestResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  passed: boolean;
}

export interface IChangeset {
  _id: string;
  runId: string;
  repoId: string;
  files: IChangedFile[];
  testCommand?: string;
  testResult?: ITestResult;
  status: "pending_review" | "approved" | "rejected";
  createdAt: Date;
  updatedAt: Date;
}

const changedFileSchema = new Schema<IChangedFile>(
  {
    path: { type: String, required: true },
    changeType: {
      type: String,
      enum: ["added", "modified", "deleted"],
      required: true,
    },
    diff: { type: String, required: true },
  },
  { _id: false }
);

const testResultSchema = new Schema<ITestResult>(
  {
    exitCode: { type: Number, required: true },
    stdoutTail: { type: String, default: "" },
    stderrTail: { type: String, default: "" },
    passed: { type: Boolean, required: true },
  },
  { _id: false }
);

const changesetSchema = new Schema<IChangeset>(
  {
    _id: { type: String, required: true },
    runId: { type: String, required: true, index: true },
    repoId: { type: String, required: true, index: true },
    files: { type: [changedFileSchema], default: [] },
    testCommand: { type: String },
    testResult: { type: testResultSchema },
    status: {
      type: String,
      enum: ["pending_review", "approved", "rejected"],
      default: "pending_review",
      index: true,
    },
  },
  { timestamps: true }
);

export const Changeset = model<IChangeset>("Changeset", changesetSchema, "changesets");

