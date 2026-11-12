"""Create MongoDB regular and vector search indexes for CodeScout chunks."""

import json
import os
import sys
import time

from pymongo import ASCENDING, MongoClient
from pymongo.errors import OperationFailure
from pymongo.operations import SearchIndexModel


def get_vector_index_definition(dimensions: int) -> dict:
    return {
        "fields": [
            {
                "type": "vector",
                "path": "embedding",
                "numDimensions": dimensions,
                "similarity": "cosine",
            },
            {
                "type": "filter",
                "path": "repoId",
            },
        ]
    }


def main() -> int:
    mongo_uri = os.environ.get(
        "MONGODB_URI",
        "mongodb://mongo:27017/codescout?directConnection=true",
    )
    dimensions = int(os.environ.get("EMBEDDING_DIMENSIONS", "2048"))

    definition = get_vector_index_definition(dimensions)
    print("Atlas Vector Search index 'chunks_vector' JSON definition (for Atlas UI):")
    print(json.dumps(definition, indent=2))

    client = MongoClient(mongo_uri)
    db = client.get_default_database()
    if db is None:
        db = client["codescout"]
    chunks = db["chunks"]

    # Ensure collection exists before creating search indexes
    if "chunks" not in db.list_collection_names():
        db.create_collection("chunks")

    # Regular compound index
    chunks.create_index([("repoId", ASCENDING), ("filePath", ASCENDING)], name="repo_filepath_idx")
    print("Ensured regular index 'repo_filepath_idx' on chunks { repoId: 1, filePath: 1 }.")

    existing = {idx["name"] for idx in chunks.list_search_indexes()}
    if "chunks_vector" in existing:
        print("Vector search index 'chunks_vector' already exists.")
        return 0

    model = SearchIndexModel(
        definition=definition,
        name="chunks_vector",
        type="vectorSearch",
    )

    # mongodb-atlas-local's mongot sidecar can take a few seconds after startup to accept commands
    for attempt in range(6):
        try:
            name = chunks.create_search_index(model=model)
            print(f"Created vector search index: {name}")
            return 0
        except OperationFailure as exc:
            if attempt < 5:
                print(f"Waiting for search index service (attempt {attempt + 1}/6): {exc}")
                time.sleep(3)
                continue
            print(f"Could not create search index via driver: {exc}", file=sys.stderr)
            print("If using MongoDB Atlas Free Tier, create 'chunks_vector' in Atlas UI using the JSON above.")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

