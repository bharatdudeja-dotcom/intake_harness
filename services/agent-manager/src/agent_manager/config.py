"""Configuration. Nothing here names an agent, a stage or a model."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT / ".env", env_prefix="AM_", extra="ignore"
    )

    # sqlite for local; a postgresql+psycopg:// URL on Cloud Run.
    database_url: str = f"sqlite:///{(ROOT / 'agent_manager.db').as_posix()}"

    config_dir: Path = ROOT / "config"
    journey_file: str = "journey.xfinity-creative-intake.yaml"
    agents_file: str = "agents.yaml"

    # Gate links are signed; the key lives in Secret Manager in a deployed env.
    jwt_signing_key: str = "dev-only-not-a-secret"
    gate_link_ttl_seconds: int = 60 * 60 * 24 * 3
    base_url: str = "http://127.0.0.1:8080"

    # D9: we call Workfront through the in-house MCP estate (chaunceyplum/mcp),
    # not Adobe's official connector. This is the gateway root — the same value
    # the harness puts in MCP_ENDPOINT_URL. A trailing /mcp is stripped.
    mcp_endpoint_url: str | None = None
    workfront_instance: str = "taplondonptrsd.my.workfront.com"

    # Every Workfront write is confirmed by a human before it executes.
    require_human_confirm_on_write: bool = True

    @property
    def is_postgres(self) -> bool:
        return self.database_url.startswith("postgres")


@lru_cache
def settings() -> Settings:
    return Settings()


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}
