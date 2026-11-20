#!/usr/bin/env python3
"""Fail if any tracked file mentions a company or customer name that must not ship.

ImpactIQ is published for anyone to self-host, so the repo must stay free of the
names of organizations it was first deployed at. The names themselves can't be
listed here without defeating the check, so this file holds only the SHA-256 of
each lowercased term. Every run of letters and digits in every tracked text file
is lowercased and each window of a banned term's length is hashed and compared,
so a term is caught inside identifiers, email domains and camelCase too.

To ban another term, add sha256(term.lower()) and its length to BANNED below:
    python3 -c "import hashlib; print(hashlib.sha256(b'term').hexdigest())"
"""
import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (length, sha256 of the lowercased term)
BANNED = {
    (7, "7dd9d956246d2f1ec81bcdc474cd15aa724e867d4de03bfdbc296d3bc5d862a9"),
}

# Generated or vendored files that are never hand-edited.
SKIP = {"package-lock.json"}

RUN = re.compile(rb"[a-z0-9]+")


def tracked_files() -> list[Path]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True).stdout
    return [ROOT / p.decode() for p in out.split(b"\0") if p and Path(p.decode()).name not in SKIP]


def scan(data: bytes) -> list[int]:
    hits: list[int] = []
    lengths = sorted({n for n, _ in BANNED})
    hashes = {h for _, h in BANNED}
    lowered = data.lower()
    for m in RUN.finditer(lowered):
        run = m.group()
        for n in lengths:
            for i in range(len(run) - n + 1):
                if hashlib.sha256(run[i:i + n]).hexdigest() in hashes:
                    hits.append(m.start() + i)
    return hits


def main() -> int:
    failures = 0
    for path in tracked_files():
        try:
            data = path.read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            continue
        if b"\0" in data[:8192]:
            continue  # binary
        for offset in scan(data):
            line = data.count(b"\n", 0, offset) + 1
            print(f"{path.relative_to(ROOT)}:{line}: banned term")
            failures += 1
    if failures:
        print(f"\n{failures} banned-term match(es). Replace them with a generic word (see this script's docstring).")
        return 1
    print("No banned terms found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
