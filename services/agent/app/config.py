from functools import lru_cache

from pydantic import AliasChoices, Field
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
    embedding_dimensions: int = 2048
    rerank_model: str = ""
    rerank_base_url: str = ""
    llm_rpm_limit: int = 35
    llm_max_retries: int = 5

    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = Field(
        default="https://cloud.langfuse.com",
        validation_alias=AliasChoices("LANGFUSE_HOST", "LANGFUSE_BASE_URL", "langfuse_host"),
    )

    max_files_per_repo: int = 3000
    embedding_batch_size: int = 32
    max_agent_steps: int = 15
    repos_dir: str = "/data/repos"

    docker_host: str = Field(
        default="http://docker-socket-proxy:2375",
        validation_alias=AliasChoices("DOCKER_HOST", "docker_host"),
    )
    sandbox_image: str = Field(
        default="codescout-sandbox:latest",
        validation_alias=AliasChoices("SANDBOX_IMAGE", "sandbox_image"),
    )
    sandbox_timeout_seconds: int = Field(
        default=120,
        validation_alias=AliasChoices("SANDBOX_TIMEOUT_SECONDS", "sandbox_timeout_seconds"),
    )
    sandbox_memory: str = Field(
        default="1g",
        validation_alias=AliasChoices("SANDBOX_MEMORY", "sandbox_memory"),
    )
    sandbox_cpus: float = Field(
        default=1.0,
        validation_alias=AliasChoices("SANDBOX_CPUS", "sandbox_cpus"),
    )
    repos_volume_host_path: str = Field(
        default="/var/lib/docker/volumes/code-scout_repos_data/_data",
        validation_alias=AliasChoices("REPOS_VOLUME_HOST_PATH", "repos_volume_host_path"),
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
