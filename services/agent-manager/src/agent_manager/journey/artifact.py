"""Artifact specs, loaded from YAML.

Josh: "the stages in each act are the digital artifacts". This is that, made
checkable. The validator answers the question asked in the team chat — "I need
someone to validate whether what the agent created is enough for the task" — by
naming the field at fault instead of returning a bare incomplete.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import yaml

from agent_manager.config import settings


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    type: str
    section: str
    required: bool = False
    blocks_submission: bool = False
    options: tuple[str, ...] = ()
    hint: str = ""
    pattern: str | None = None
    required_when: dict[str, Any] = field(default_factory=dict)
    ambiguous_values: tuple[str, ...] = ()
    flag_when_ambiguous: bool = False


@dataclass(frozen=True)
class ArtifactSpec:
    key: str
    name: str
    stage: str
    version: str
    fields: tuple[Field, ...]

    def field(self, key: str) -> Field | None:
        return next((f for f in self.fields if f.key == key), None)


@lru_cache
def load_artifact(key: str) -> ArtifactSpec:
    path = settings().config_dir / f"artifact.{key}.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    fields: list[Field] = []
    for section in raw.get("sections", []):
        for f in section.get("fields", []):
            fields.append(
                Field(
                    key=f["key"],
                    label=f.get("label", f["key"]),
                    type=f.get("type", "string"),
                    section=section.get("title", ""),
                    required=bool(f.get("required", False)),
                    blocks_submission=bool(f.get("blocks_submission", False)),
                    options=tuple(f.get("options") or ()),
                    hint=(f.get("hint") or "").strip(),
                    pattern=f.get("pattern"),
                    required_when=f.get("required_when") or {},
                    ambiguous_values=tuple(
                        v.lower() for v in (f.get("ambiguous_values") or ())
                    ),
                    flag_when_ambiguous=bool(f.get("flag_when_ambiguous", False)),
                )
            )
    return ArtifactSpec(
        key=raw["key"],
        name=raw.get("name", raw["key"]),
        stage=raw.get("stage", ""),
        version=str(raw.get("version", "1")),
        fields=tuple(fields),
    )


@dataclass
class Validation:
    missing: list[Field]
    ambiguous: list[tuple[Field, str]]
    invalid: list[tuple[Field, str]]

    @property
    def blocks(self) -> bool:
        return any(f.blocks_submission for f in self.missing) or bool(self.invalid)

    @property
    def ok(self) -> bool:
        return not (self.missing or self.ambiguous or self.invalid)

    def question(self) -> str:
        """What the gate actually asks the human. Names the field."""
        if self.missing:
            names = ", ".join(f.label for f in self.missing[:4])
            return f"The intake is missing: {names}. Is it enough for the task?"
        if self.ambiguous:
            names = ", ".join(f.label for f, _ in self.ambiguous[:4])
            return f"The marketer could not answer: {names}. Proceed anyway?"
        return "Is what the agent created enough for the task?"


def validate(spec: ArtifactSpec, values: dict[str, Any]) -> Validation:
    import re

    missing: list[Field] = []
    ambiguous: list[tuple[Field, str]] = []
    invalid: list[tuple[Field, str]] = []

    for f in spec.fields:
        raw = values.get(f.key)
        present = raw not in (None, "", [], {})
        required = f.required or _conditional(f, values)

        if required and not present:
            missing.append(f)
            continue
        if not present:
            continue

        text = str(raw).strip()
        if f.ambiguous_values and text.lower() in f.ambiguous_values:
            if f.flag_when_ambiguous:
                ambiguous.append((f, text))
            continue
        if f.pattern and not re.match(f.pattern, text):
            invalid.append((f, f"{text!r} does not match {f.pattern}"))
        elif f.options and f.type == "enum" and text not in f.options:
            invalid.append((f, f"{text!r} is not one of the allowed values"))

    return Validation(missing=missing, ambiguous=ambiguous, invalid=invalid)


def _conditional(f: Field, values: dict[str, Any]) -> bool:
    for key, expected in (f.required_when or {}).items():
        if key.endswith("_count_gt"):
            target = key[: -len("_count_gt")]
            actual = values.get(target) or []
            if isinstance(actual, str):
                actual = [a for a in actual.split(",") if a.strip()]
            if len(actual) > int(expected):
                return True
        elif str(values.get(key, "")).strip() == str(expected):
            return True
    return False
