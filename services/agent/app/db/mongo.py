from functools import lru_cache

from pymongo import MongoClient
from pymongo.database import Database

from app.config import get_settings


@lru_cache
def get_mongo_client() -> MongoClient:
    settings = get_settings()
    return MongoClient(settings.mongodb_uri)


def get_db() -> Database:
    client = get_mongo_client()
    db = client.get_default_database()
    return db if db is not None else client["codescout"]

