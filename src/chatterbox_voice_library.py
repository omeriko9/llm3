from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


MANIFEST_FILENAME = ".llm3-chatterbox-voices.json"
UPLOADS_DIRNAME = ".llm3-voices"
VOICE_NAME_RE = re.compile(r"[^A-Za-z0-9_-]+")


def normalize_voice_name(value: object, fallback: str = "voice") -> str:
    normalized = VOICE_NAME_RE.sub("-", str(value or "").strip()).strip("-_").lower()
    return normalized or fallback


def manifest_path(model_root: str | Path) -> Path:
    return Path(model_root).expanduser() / MANIFEST_FILENAME


def uploads_dir(model_root: str | Path) -> Path:
    return Path(model_root).expanduser() / UPLOADS_DIRNAME


def resolve_prompt_path(model_root: Path, prompt_path: str | None) -> Path:
    if prompt_path is None:
        return model_root
    candidate = Path(os.path.expanduser(str(prompt_path)))
    if candidate.is_absolute():
        return candidate
    return model_root / candidate


def _safe_relative_path(model_root: Path, candidate: Path) -> str:
    try:
        return candidate.resolve().relative_to(model_root.resolve()).as_posix()
    except Exception:
        return str(candidate)


def _voice_exists(model_root: Path, prompt_path: str | None) -> bool:
    if prompt_path is None:
        return True
    resolved = resolve_prompt_path(model_root, prompt_path)
    return resolved.exists() and resolved.is_file()


def _normalize_entry(model_root: Path, raw: dict[str, Any], *, index: int) -> dict[str, Any]:
    prompt_path = raw.get("prompt_path")
    if prompt_path is None:
        normalized_prompt_path = None
    else:
        normalized_prompt_path = str(prompt_path).strip() or None
    name = normalize_voice_name(raw.get("name"), fallback=f"voice-{index}")
    aliases = []
    for alias in raw.get("aliases") or []:
        normalized_alias = normalize_voice_name(alias)
        if normalized_alias and normalized_alias != name and normalized_alias not in aliases:
            aliases.append(normalized_alias)
    builtin = bool(raw.get("builtin")) or normalized_prompt_path is None
    resolved_prompt = resolve_prompt_path(model_root, normalized_prompt_path) if normalized_prompt_path is not None else None
    deletable = bool(raw.get("deletable")) if "deletable" in raw else (
        not builtin
        and resolved_prompt is not None
        and str(resolved_prompt.resolve()).startswith(str(model_root.resolve()))
    )
    entry = {
        "name": name,
        "prompt_path": normalized_prompt_path,
        "aliases": aliases,
        "builtin": builtin,
        "deletable": deletable,
    }
    if raw.get("language"):
        entry["language"] = str(raw.get("language")).strip()
    return entry


def _write_manifest(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def load_manifest(
    model_root: str | Path,
    *,
    legacy_voices: list[dict[str, Any]] | None = None,
    default_voice: str = "",
) -> dict[str, Any]:
    root = Path(model_root).expanduser()
    path = manifest_path(root)
    payload: dict[str, Any]
    if path.exists():
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            payload = {}
    else:
        payload = {}

    raw_entries = payload.get("voices")
    if not isinstance(raw_entries, list) or not raw_entries:
        raw_entries = list(legacy_voices or [])

    normalized_entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw_entry in enumerate(raw_entries, start=1):
        if not isinstance(raw_entry, dict):
            continue
        entry = _normalize_entry(root, raw_entry, index=index)
        if entry["name"] in seen:
            continue
        seen.add(entry["name"])
        normalized_entries.append(entry)

    if not normalized_entries:
        normalized_entries.append({
            "name": "builtin",
            "prompt_path": None,
            "aliases": ["default"],
            "builtin": True,
            "deletable": False,
        })

    configured_default = normalize_voice_name(payload.get("default_voice") or default_voice or normalized_entries[0]["name"])
    available_names = {entry["name"] for entry in normalized_entries}
    if configured_default not in available_names:
        configured_default = normalized_entries[0]["name"]

    manifest = {
        "version": 1,
        "default_voice": configured_default,
        "voices": normalized_entries,
    }

    existing_text = path.read_text(encoding="utf-8") if path.exists() else ""
    next_text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    if existing_text != next_text:
        _write_manifest(path, manifest)
    return manifest


def build_voice_catalog(
    model_root: str | Path,
    *,
    legacy_voices: list[dict[str, Any]] | None = None,
    default_voice: str = "",
) -> dict[str, Any]:
    root = Path(model_root).expanduser()
    manifest = load_manifest(root, legacy_voices=legacy_voices, default_voice=default_voice)
    voices: list[dict[str, Any]] = []
    for entry in manifest["voices"]:
        prompt_path = entry.get("prompt_path")
        resolved = resolve_prompt_path(root, prompt_path) if prompt_path is not None else None
        voices.append({
            "name": entry["name"],
            "aliases": list(entry.get("aliases") or []),
            "builtin": bool(entry.get("builtin")),
            "deletable": bool(entry.get("deletable")),
            "language": str(entry.get("language") or "").strip(),
            "prompt_path": str(resolved) if resolved is not None else "",
            "prompt_path_relative": _safe_relative_path(root, resolved) if resolved is not None else "",
            "exists": _voice_exists(root, prompt_path),
        })
    return {
        "default_voice": manifest["default_voice"],
        "voices": voices,
    }


def available_voice_names(catalog: dict[str, Any], *, include_unavailable: bool = False) -> list[str]:
    names: list[str] = []
    for entry in catalog.get("voices") or []:
        if not isinstance(entry, dict):
            continue
        if not include_unavailable and not entry.get("exists"):
            continue
        name = str(entry.get("name") or "").strip()
        if name and name not in names:
            names.append(name)
    return names


def resolve_voice(
    model_root: str | Path,
    voice_name: str | None,
    *,
    explicit_prompt_path: str | None = None,
    legacy_voices: list[dict[str, Any]] | None = None,
    default_voice: str = "",
) -> tuple[str | None, str]:
    root = Path(model_root).expanduser()
    if explicit_prompt_path:
        prompt = resolve_prompt_path(root, explicit_prompt_path)
        return (str(prompt), normalize_voice_name(voice_name or prompt.stem or "custom"))

    requested = normalize_voice_name(voice_name or default_voice or "")
    catalog = build_voice_catalog(root, legacy_voices=legacy_voices, default_voice=default_voice)
    voice_entries = {
        str(entry.get("name") or ""): entry
        for entry in catalog.get("voices") or []
        if isinstance(entry, dict)
    }
    alias_map: dict[str, str] = {}
    for entry in voice_entries.values():
        for alias in entry.get("aliases") or []:
            alias_map.setdefault(normalize_voice_name(alias), str(entry.get("name") or ""))

    resolved_name = voice_entries.get(requested, {}).get("name") or alias_map.get(requested) or requested
    entry = voice_entries.get(str(resolved_name))
    if not entry:
        custom_path = resolve_prompt_path(root, str(voice_name or ""))
        if custom_path.exists() and custom_path.is_file():
            return (str(custom_path), normalize_voice_name(custom_path.stem))
        # Each chatterbox runtime owns a separate voice library under its own
        # model directory, so the useful question is always "which model was
        # asked?". Name it, and list what it does have.
        known = ", ".join(available_voice_names(catalog, include_unavailable=True)) or "(none)"
        raise ValueError(
            f"unknown chatterbox voice '{voice_name}' for model at {root}. Known voices: {known}"
        )
    if not entry.get("exists"):
        raise ValueError(
            f"voice '{resolved_name}' is configured but its prompt file is missing: {entry.get('prompt_path') or '[builtin]'}"
        )
    if entry.get("builtin"):
        return (None, str(resolved_name))
    return (str(resolve_prompt_path(root, str(entry.get("prompt_path") or ""))), str(resolved_name))


def sync_metadata_voices(model_root: str | Path, voices: list[str]) -> None:
    root = Path(model_root).expanduser()
    metadata_path = root / ".llm3-voice.json"
    if not metadata_path.exists():
        return
    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    except Exception:
        return
    next_payload = dict(payload)
    next_payload["voices"] = list(voices)
    current_text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    next_text = json.dumps(next_payload, indent=2, ensure_ascii=False) + "\n"
    if current_text == next_text:
        return
    tmp_path = metadata_path.with_suffix(".json.tmp")
    tmp_path.write_text(next_text, encoding="utf-8")
    tmp_path.replace(metadata_path)
