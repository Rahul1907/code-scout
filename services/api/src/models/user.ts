import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const userSchema = new Schema(
  {
    githubId: { type: Number, required: true, unique: true, index: true },
    login: { type: String, required: true },
    name: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
    accessTokenEncrypted: { type: String, required: true },
  },
  { timestamps: true },
);

export type UserFields = InferSchemaType<typeof userSchema>;
export type UserDoc = UserFields & {
  _id: mongoose.Types.ObjectId;
};

export const User: Model<UserFields> =
  (mongoose.models.User as Model<UserFields> | undefined) ??
  mongoose.model<UserFields>("User", userSchema);
