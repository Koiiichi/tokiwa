"""Receive or send one file or directory for `tokiwa cp`, as the session user.

Run as the session user, never as root: every path is resolved with the rights of that user.

    python3 -I tokiwa-transfer.py receive DEST KIND NAME SHA256 SIZE MODE FORCE < stream
    python3 -I tokiwa-transfer.py send SOURCE > stream

DEST and SOURCE are an absolute path or `SESSION:PATH`, where PATH is relative to the folder of
the session's active pane. Both must stay inside the workbench folder or the session cache root
after every link is followed. KIND is `file` or `dir`; a directory travels as a tar stream whose
entries all start with NAME. FORCE is `1` to replace an existing file, else `0`.

`receive` prints one JSON object: path, kind, files, bytes, sha256. `send` writes its report as
the last line of stderr, after the prefix `tokiwa-transfer `: kind, name, files, mode. A refusal
is one sentence on stderr and exit status 1, and it leaves no file behind.
"""

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

WORKDIR = Path(os.environ.get("TOKIWA_WORKDIR", "/srv/development/state/workspaces/workbench"))
CACHE_ROOT_FILE = Path(os.environ.get("TOKIWA_CACHE_ROOT_FILE", "/etc/tokiwa/cache-root"))
SOCKET = os.environ.get("TOKIWA_SOCKET", "/run/cloud-workbench/tmux.sock")
MAX_BYTES = 10 * 1024**3
MAX_FILES = 10000
# A stream is the content plus, for a directory, the tar headers: about 1.5 KB for each entry.
STREAM_LIMIT = MAX_BYTES + 64 * 1024**2
# The deploy guard of the host stops below this share of free space on a disk; a transfer must
# not be the thing that crosses it.
MIN_FREE_SHARE = float(os.environ.get("TOKIWA_MIN_FREE_SHARE", "0.20"))
REPORT_PREFIX = "tokiwa-transfer "
SESSION = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}")
CHUNK = 1024 * 1024


def cache_root():
    """Return the session cache root as the shells of the sessions read it, or None."""
    value = os.environ.get("TOKIWA_CACHE_ROOT", "")
    if not value:
        try:
            value = CACHE_ROOT_FILE.read_text().strip()
        except OSError:
            return None
    return Path(value) if value.startswith("/") else None


def roots():
    found = [WORKDIR]
    cache = cache_root()
    if cache is not None:
        found.append(cache)
    return [Path(os.path.realpath(root)) for root in found if root.is_dir()]


def inside_roots(real):
    return any(real == root or real.is_relative_to(root) for root in roots())


def session_folder(name):
    try:
        found = subprocess.run(
            ["tmux", "-N", "-S", SOCKET, "display-message", "-p", "-t", f"={name}:", "#{pane_current_path}"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        found = None
    if found is None or found.returncode or not found.stdout.strip().startswith("/"):
        raise ValueError(f"No session named {name}.")
    return Path(found.stdout.strip())


def location(spec):
    """Return the path that a DEST or SOURCE argument names, before links are followed."""
    if spec.startswith("/"):
        return Path(spec)
    name, colon, rest = spec.partition(":")
    if not colon or not SESSION.fullmatch(name):
        raise ValueError("Use an absolute path or SESSION:PATH.")
    if rest.startswith("/"):
        return Path(rest)
    return session_folder(name) / rest


def refuse_outside(real):
    if not inside_roots(real):
        raise ValueError("The path is outside the workbench folder and the session cache. Nothing was copied.")


def check_free_space(folder, needed):
    disk = os.statvfs(folder)
    total = disk.f_blocks * disk.f_frsize
    free = disk.f_bavail * disk.f_frsize
    if free - needed < MIN_FREE_SHARE * total:
        raise ValueError(
            f"The disk of {folder} would have less than {int(MIN_FREE_SHARE * 100)} % free space. Nothing was copied."
        )


def target_of(dest, name, wants_folder):
    """Return the folder and the final path that a received NAME gets under DEST."""
    real = Path(os.path.realpath(dest))
    if real.is_dir():
        return real, real / name
    if wants_folder:
        raise ValueError(f"The folder {dest} does not exist. Nothing was copied.")
    # A link as the target could name a file outside the allowed folders or on another disk, and the
    # write would follow it. The caller names the real file instead.
    if dest.is_symlink():
        raise ValueError(f"{dest} is a link. Name the file that it points to. Nothing was copied.")
    parent = Path(os.path.realpath(dest.parent))
    if not parent.is_dir():
        raise ValueError(f"The folder {dest.parent} does not exist. Nothing was copied.")
    return parent, parent / dest.name


def write_stream(stream, part, size, digest):
    written = 0
    with open(part, "wb") as out:
        while chunk := stream.read(CHUNK):
            written += len(chunk)
            if written > size:
                break
            digest.update(chunk)
            out.write(chunk)
    return written


def within(name, path):
    return (path == name or path.startswith(name + "/")) and ".." not in path.split("/")


def link_within(name, member):
    """True unless the member is a link whose target leaves NAME once the tree is in place."""
    if member.issym():
        if member.linkname.startswith("/"):
            return False
        # The data filter keeps a link inside the staging folder only; NAME is one level deeper.
        return within(name, os.path.normpath(os.path.join(os.path.dirname(member.name), member.linkname)))
    if member.islnk():
        return within(name, os.path.normpath(member.linkname))
    return True


def extract(part, folder, name):
    """Extract the tar stream in `part` into a new folder under `folder`, and return NAME inside it."""
    staging = Path(tempfile.mkdtemp(prefix=".tokiwa-cp-", dir=folder))
    try:
        with tarfile.open(part, "r:") as archive:
            members = archive.getmembers()
            if len(members) > MAX_FILES:
                raise ValueError(f"The directory holds more than {MAX_FILES} entries. Nothing was copied.")
            for member in members:
                if not within(name, member.name) or not link_within(name, member):
                    raise ValueError(f"The directory holds an entry outside {name}, or a link out of it. Nothing was copied.")
            # The data filter refuses absolute names, `..`, links that leave the folder and device
            # files, and drops setuid, setgid and sticky bits (Python 3.12, PEP 706).
            archive.extractall(staging, filter="data")
    except (tarfile.TarError, OSError) as error:
        shutil.rmtree(staging, ignore_errors=True)
        raise ValueError(f"The directory could not be unpacked: {error}. Nothing was copied.")
    except ValueError:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    top = staging / name
    if top.is_symlink() or not top.is_dir():
        shutil.rmtree(staging, ignore_errors=True)
        raise ValueError(f"The stream does not hold a directory named {name}. Nothing was copied.")
    return staging, top, len(members)


def receive(dest_spec, kind, name, sha256, size, mode, force, stream):
    if kind not in ("file", "dir"):
        raise ValueError("The kind must be file or dir.")
    if not name or "/" in name or name in (".", "..") or len(name.encode()) > 255:
        raise ValueError("The name is not a valid file name.")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError("The SHA-256 is not valid.")
    if not 0 <= size <= STREAM_LIMIT:
        raise ValueError(f"A transfer holds at most {MAX_BYTES // 1024**3} GB. Nothing was copied.")
    folder, target = target_of(location(dest_spec), name, dest_spec.endswith("/"))
    refuse_outside(folder)
    replace = False
    if os.path.lexists(target):
        if kind == "dir" or target.is_dir():
            raise ValueError(f"{target} exists. A directory is never replaced. Nothing was copied.")
        if not force:
            raise ValueError(f"{target} exists. Use --force to replace it. Nothing was copied.")
        if target.is_symlink() or not target.is_file():
            raise ValueError(f"{target} is not a regular file. Nothing was copied.")
        replace = True
    # A directory needs room for the stream and for the unpacked copy at the same time.
    check_free_space(folder, size * (2 if kind == "dir" else 1))
    descriptor, part = tempfile.mkstemp(prefix=".tokiwa-cp-", suffix=".part", dir=folder)
    os.close(descriptor)
    staging = None
    try:
        digest = hashlib.sha256()
        written = write_stream(stream, part, size, digest)
        if written != size or digest.hexdigest() != sha256:
            raise ValueError("The copy on the host does not match the source. Nothing was copied.")
        if kind == "file":
            os.chmod(part, mode & 0o777)
            if replace:
                os.replace(part, target)
            else:
                # A link fails when the target appeared meanwhile, so no file is overwritten.
                os.link(part, target)
                os.unlink(part)
            files = 1
        else:
            staging, top, files = extract(part, folder, name)
            if os.path.lexists(target):
                raise ValueError(f"{target} exists. A directory is never replaced. Nothing was copied.")
            os.rename(top, target)
    except FileExistsError:
        raise ValueError(f"{target} exists. Use --force to replace it. Nothing was copied.")
    except OSError as error:
        raise ValueError(f"{target} could not be written: {error.strerror}. Nothing was copied.")
    finally:
        if os.path.lexists(part):
            os.unlink(part)
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
    return {"path": str(target), "kind": kind, "files": files, "bytes": size, "sha256": sha256}


def count_tree(top):
    """Return the entries and the bytes under `top`, or refuse a tree over the limits."""
    entries, total = 1, 0
    for folder, dirs, files in os.walk(top):
        for entry in dirs + files:
            path = Path(folder) / entry
            info = path.lstat()
            if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
                raise ValueError(f"{path} is not a file, a folder or a link. Nothing was copied.")
            entries += 1
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
            if entries > MAX_FILES:
                raise ValueError(f"The directory holds more than {MAX_FILES} entries. Nothing was copied.")
            if total > MAX_BYTES:
                raise ValueError(f"A transfer holds at most {MAX_BYTES // 1024**3} GB. Nothing was copied.")
    return entries, total


class Capped:
    """A writer that stops a stream at STREAM_LIMIT: a file can grow while it is read."""

    def __init__(self, out):
        self.out = out
        self.size = 0

    def write(self, data):
        self.size += len(data)
        if self.size > STREAM_LIMIT:
            raise ValueError(f"A transfer holds at most {MAX_BYTES // 1024**3} GB. Nothing was copied.")
        return self.out.write(data)


def plain_member(member):
    member.uid = member.gid = 0
    member.uname = member.gname = ""
    return member


def send(source_spec, out, report):
    source = location(source_spec)
    real = Path(os.path.realpath(source))
    if not real.exists():
        raise ValueError(f"{source} does not exist. Nothing was copied.")
    refuse_outside(real)
    name = source.name or real.name
    if real.is_file():
        info = real.stat()
        if info.st_size > MAX_BYTES:
            raise ValueError(f"A transfer holds at most {MAX_BYTES // 1024**3} GB. Nothing was copied.")
        report({"kind": "file", "name": name, "files": 1, "mode": info.st_mode & 0o777})
        with open(real, "rb") as stream:
            capped = Capped(out)
            while chunk := stream.read(CHUNK):
                capped.write(chunk)
        return
    if not real.is_dir():
        raise ValueError(f"{source} is not a file or a folder. Nothing was copied.")
    entries, _ = count_tree(real)
    report({"kind": "dir", "name": name, "files": entries, "mode": real.stat().st_mode & 0o777})
    with tarfile.open(fileobj=Capped(out), mode="w|", format=tarfile.PAX_FORMAT) as archive:
        archive.add(real, arcname=name, filter=plain_member)


def main(argv):
    try:
        if len(argv) == 8 and argv[0] == "receive":
            dest, kind, name, sha256, size, mode, force = argv[1:]
            if not re.fullmatch(r"[0-9]{1,12}", size) or not re.fullmatch(r"[0-7]{3,4}", mode) or force not in ("0", "1"):
                raise ValueError("Use receive DEST KIND NAME SHA256 SIZE MODE FORCE.")
            result = receive(dest, kind, name, sha256, int(size), int(mode, 8), force == "1", sys.stdin.buffer)
            print(json.dumps(result))
            return 0
        if len(argv) == 2 and argv[0] == "send":
            send(argv[1], sys.stdout.buffer,
                 lambda facts: print(REPORT_PREFIX + json.dumps(facts), file=sys.stderr, flush=True))
            sys.stdout.buffer.flush()
            return 0
        raise ValueError("Use receive DEST KIND NAME SHA256 SIZE MODE FORCE, or send SOURCE.")
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
