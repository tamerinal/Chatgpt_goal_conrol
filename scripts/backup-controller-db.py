"""Explicitly invoked SQLite online snapshot; never repairs the source database."""
import argparse
import json
from pathlib import Path
import sqlite3
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination")
    args = parser.parse_args()
    source = Path(args.source).resolve(strict=True)
    destination = Path(args.destination).resolve()
    if source == destination or destination.exists():
        raise RuntimeError("Destination must be a new file, not the source")
    deadline = time.monotonic() + 30

    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise TimeoutError("Online snapshot deadline exceeded; partial destination is not a valid backup")

    # mode=ro includes committed WAL content; immutable=1 would incorrectly omit it.
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5) as original:
        with sqlite3.connect(destination) as snapshot:
            original.backup(snapshot, pages=128, progress=progress, sleep=0.05)
    with sqlite3.connect(destination.as_uri() + "?mode=ro", uri=True) as snapshot:
        tables = snapshot.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        counts = {}
        for (name,) in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            counts[name] = snapshot.execute("SELECT count(*) FROM " + quoted).fetchone()[0]
    print(json.dumps({"method": "sqlite-online-backup", "complete": True,
                      "tableCounts": counts, "sourceChangedByHelper": False}))


if __name__ == "__main__":
    main()
