import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";

const chunkSchema = new Schema(
  {
    repoId: { type: String, required: true, index: true },
    filePath: { type: String, required: true },
    language: { type: String, required: true },
    symbolName: { type: String, required: true },
    symbolType: {
      type: String,
      enum: ["function", "class", "method", "module", "block"],
      required: true,
    },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
    content: { type: String, required: true },
    contentHash: { type: String, required: true },
    embedding: { type: [Number], required: true },
  },
  { timestamps: true },
);

chunkSchema.index({ repoId: 1, filePath: 1 });

export type ChunkFields = InferSchemaType<typeof chunkSchema>;

export const Chunk: Model<ChunkFields> =
  (mongoose.models.Chunk as Model<ChunkFields> | undefined) ??
  mongoose.model<ChunkFields>("Chunk", chunkSchema);

