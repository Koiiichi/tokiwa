"""Read bounded workspace listings and text previews without following links."""

import base64
import json
import os
import stat
import sys
from pathlib import Path

ROOT = Path("/srv/development/state/workspaces")
LIMIT = 40


def inspect_path(root, relative="", offset=0):
    """Use directory descriptors so a renamed path cannot redirect a read."""
    parts = Path(relative).parts
    if Path(relative).is_absolute() or any(p in ("..", ".") for p in parts):
        raise ValueError("Use a path inside the selected workspace.")
    if type(offset) is not int or not 0 <= offset <= 100000:
        raise ValueError("The directory page is invalid.")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            if (
                part.lower()
                in (
                    ".ssh",
                    ".aws",
                    ".codex",
                    ".claude",
                    ".env",
                    "credentials",
                    ".npmrc",
                    ".netrc",
                    ".git-credentials",
                    "id_rsa",
                    "id_ed25519",
                    "auth.json",
                    "tokens.json",
                )
                or part.lower().startswith(".env.")
                or part.lower().endswith((".pem", ".key"))
            ):
                raise ValueError("Private configuration is excluded from previews.")
            next_fd = os.open(
                part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
            )
            os.close(fd)
            fd = next_fd
        mode = os.fstat(fd).st_mode
        if stat.S_ISDIR(mode):
            rows = []
            # Directory order is retained for bounded pagination without a full scan.
            with os.scandir(fd) as entries:
                for index, entry in enumerate(entries):
                    if index < offset:
                        continue
                    if len(rows) == LIMIT:
                        break
                    kind = (
                        "link"
                        if entry.is_symlink()
                        else "directory"
                        if entry.is_dir(follow_symlinks=False)
                        else "file"
                        if entry.is_file(follow_symlinks=False)
                        else "special"
                    )
                    rows.append({"name": entry.name, "kind": kind})
                else:
                    return {
                        "path": relative,
                        "entries": rows,
                        "offset": offset,
                        "more": False,
                    }
            return {"path": relative, "entries": rows, "offset": offset, "more": True}
        if not stat.S_ISREG(mode):
            raise ValueError("Only regular text files can be previewed.")
        data = os.read(fd, 3001)
        if b"\x00" in data:
            raise ValueError("Binary files cannot be previewed.")
        return {
            "path": relative,
            "text": data[:3000].decode("utf-8", errors="replace"),
            "truncated": len(data) > 3000,
        }
    finally:
        os.close(fd)


def main():
    try:
        request = json.loads(base64.b64decode(sys.argv[1], validate=True))
        if not isinstance(request, dict) or not isinstance(
            request.get("path", ""), str
        ):
            raise ValueError("The file request is invalid.")  # noqa: TRY004 - Invalid wire data.
        # All traversal starts at the fixed workspace root; private homes are outside it.
        result = inspect_path(ROOT, request.get("path", ""), request.get("offset", 0))
        encoded = json.dumps(result)
        if len(encoded) > 22000:
            raise ValueError("The directory page exceeds the response limit.")
        print(encoded)
    except (OSError, ValueError, KeyError, IndexError) as exc:
        print(
            "Tokiwa: "
            + (
                str(exc)
                if isinstance(exc, ValueError)
                else "The path is unavailable or is a symbolic link."
            ),
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
