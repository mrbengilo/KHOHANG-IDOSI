#!/usr/bin/env python3
"""Make tracked build inputs readable without changing private deployment files."""

import os
from pathlib import Path
import stat
import subprocess


def normalize_release_permissions(root: Path) -> None:
    entries = subprocess.check_output(
        ["git", "-C", str(root), "ls-files", "--stage", "-z"]
    )
    directories = {root}
    files = []
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        mode, _, stage = metadata.split()
        if stage != b"0":
            raise RuntimeError("Release checkout contains unmerged files")
        if mode not in (b"100644", b"100755"):
            # In particular, never follow a tracked symlink into a secret or
            # another checkout. Git metadata and untracked files are excluded.
            continue
        path = root / os.fsdecode(name)
        files.append((path, 0o755 if mode == b"100755" else 0o644))
        parent = path.parent
        while parent != root:
            directories.add(parent)
            parent = parent.parent

    for directory in directories:
        if not stat.S_ISDIR(directory.lstat().st_mode):
            raise RuntimeError(f"Expected a source directory: {directory}")
    for path, _ in files:
        if not stat.S_ISREG(path.lstat().st_mode):
            raise RuntimeError(f"Expected a regular tracked file: {path}")

    for directory in directories:
        directory.chmod(0o755)
    for path, mode in files:
        path.chmod(mode)


if __name__ == "__main__":
    normalize_release_permissions(Path(__file__).resolve().parents[2])
