from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    node_env: str = "development"
    internal_api_key: str = "change-me"

    mongodb_uri: str = "mongodb://mongo:27017/codescout?directConnection=true"
    redis_url: str = "redis://redis:6379"

    llm_base_url: str = "https://integrate.api.nvidia.com/v1"
    llm_api_key: str = ""
    llm_chat_model: str = ""
    llm_fast_model: str = ""
    embedding_model: str = ""
    embedding_dimensions: int = 1024
    rerank_model: str = ""
    llm_rpm_limit: int = 35
    llm_max_retries: int = 5

    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = "https://cloud.langfuse.com"

    max_files_per_repo: int = 3000
    max_agent_steps: int = 15
    repos_dir: str = "/data/repos"


@lru_cache
def get_settings() -> Settings:
    return Settings()

