"""Inspect shared Hugging Face cache without importing any worker/GPU package."""

from .db import CACHE


def downloaded(model):
    if model == "large-v3-turbo":
        repo = "mobiuslabsgmbh--faster-whisper-large-v3-turbo"
    elif model == "distil-large-v3":
        repo = "Systran--faster-distil-whisper-large-v3"
    else:
        repo = "Systran--faster-whisper-" + model
    snapshots = CACHE / ("models--" + repo) / "snapshots"
    return any(
        (p / "model.bin").is_file()
        and (p / "config.json").is_file()
        and (p / "tokenizer.json").is_file()
        for p in snapshots.glob("*")
    )
