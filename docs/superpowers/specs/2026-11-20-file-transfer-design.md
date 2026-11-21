# File transfer between the Mac and the host

Status: design. Not implemented.

## Intent

A person or a local agent copies a file or a directory between the Mac and the host with one command, `tokiwa cp`, in either direction. Today the only ways are Git, a paste into a terminal, and image paste. None of them moves an arbitrary file, a binary file or a directory, and none works without an open terminal view.

## Goals

- `tokiwa cp` uploads and downloads single files and directories.
- It works without a terminal view and without agent orchestration: a person and a local agent call it the same way.
- A transfer is checked by size and SHA-256 before the target gets its final name. A failure leaves no partial file at the target.
- It never replaces an existing target unless the caller asks for it.
- It reuses the path of image paste: the private bucket, Run Command and the session user's helper.
- No copy stays in S3 after the transfer.

## Non-goals

- Drag and drop, or an upload action in the app. A later change can call `tokiwa cp`.
- Sync, resume of an interrupted transfer, or a merge of directories.
- A transfer between two hosts, or between two sessions.
- Encryption on the Mac before the upload (see Security).

## Anti-goals

- SSH or SCP, which need `sshd` and keys on the host.
- A new AWS permission for the host, or AWS access inside the workbench.
- Root that opens a path that the caller chose.
- A transfer into the private volume, which holds the home folders, the credentials and Tokiwa's state.

## Facts this design rests on

- Image paste moves a file from the Mac to the host: the launcher uploads it to `inputs/clipboard/`, one Run Command call runs the helper `terminal-session.sh` as the session user, the helper downloads it, checks the size and the SHA-256, and renames it into place. Its limits are 10 MB and 20 seconds.
- The host role reads `inputs/*` and writes `results/*` in the artifacts bucket. The host has `boto3`; its backup uploads use it.
- The bucket is private, refuses plain HTTP, encrypts at rest (SSE-S3) and keeps versions. A lifecycle rule removes `inputs/clipboard/` objects after 1 day.
- The launcher gives each Run Command call an `executionTimeout` of 30 seconds.
- The AWS CLI on the Mac makes presigned GET links only. A presigned PUT carries at most 5 GB.
- The host runs Python 3.12, whose `tarfile` has the `data` extraction filter.
- The state disk holds the workspaces; the cache disk holds the session caches; the private volume (16 GB) holds the home folders and Tokiwa's state. When this design was written, the state disk had 68 GB free of 94, the cache disk 25 GB free of 63, and the private volume 7.5 GB free of 16.
- The hourly backup of the state disk fails above 100,000 files. It does not copy the cache disk.

## Interface

```
tokiwa cp [--force] [--json] SOURCE DEST
```

One of SOURCE and DEST is local. The other is remote:

- `SESSION:PATH`: PATH is relative to the working folder of the session, for example `worker-a:docs/`. An absolute PATH must also be inside the allowed folders.
- `host:/PATH`: an absolute path inside the allowed folders.

Examples:

```
tokiwa cp report.pdf worker-a:docs/
tokiwa cp ./fixtures host:/srv/development/cache/sessions/worker-a/tmp/fixtures
tokiwa cp worker-a:out/results.json .
```

When DEST is an existing folder, the source goes into it under its own name, as with `cp`. A directory source needs no flag.

The result is one line: the target, the count of files, the bytes and the SHA-256 of the stream. `--json` prints the same facts as one JSON object, for agents. The exit status is 0 on success, 1 on a refusal or a failure, and 2 on a usage error.

## How the bytes move

### Upload

1. The launcher checks SOURCE, counts its files and bytes, and refuses a source over the limits.
2. It makes the stream: the file itself, or a tar stream of the directory. It computes the SHA-256 and the size while it uploads the stream to `inputs/transfers/<random id>` with `aws s3 cp`, which uses a multipart upload for a large stream.
3. One Run Command call, with a timeout from the size, runs: root reads the object with `boto3` and the host role and writes it to a pipe; the helper, as the session user, reads the pipe.
4. The helper resolves DEST, checks it (see Paths), checks free space, writes the stream to a temporary name on the same disk, checks the size and the SHA-256, extracts a directory with the `data` filter into a temporary folder, and renames the result into place.
5. The launcher deletes the object version on every exit after the upload started.

### Download

1. One Run Command call runs: the helper, as the session user, resolves and checks SOURCE and writes the file or a tar stream of the directory to a pipe; root reads the pipe and uploads it to `results/transfers/<random id>` with `boto3`. The helper reports the count of files, the bytes and the SHA-256.
2. The launcher checks free space on the Mac, downloads the object to a temporary name next to DEST, checks the size and the SHA-256, extracts a directory with the `data` filter, and renames the result into place.
3. The launcher deletes the object version on every exit after the call started.

Root opens no path that the caller chose: it moves bytes between a pipe and one object, under a key that the launcher made and that the host checks (`inputs/transfers/` or `results/transfers/`, then 32 hex characters). The session user gets no AWS credentials. No presigned link is made, so the 5 GB limit of a presigned PUT does not apply.

## Directories

The sending side writes a tar stream of regular files, folders and symbolic links. The receiving side extracts it with the `tarfile` `data` filter into a new temporary folder on the target disk. The filter refuses absolute names, names with `..`, links that point outside the tree, devices and hard links to outside entries, and it removes setuid, setgid and sticky bits. No owner, ACL or extended attribute is copied. After the check, one rename puts the folder in place.

## Paths on the host

- Allowed folders: the workspace folder tree and the session cache folders.
- Every other path is refused as a source and as a destination. The private volume is always refused.
- The helper resolves each path as the session user, with every symbolic link followed. The resolved path must be inside an allowed folder.
- Files belong to the session user. On the state disk they get the default ACLs of the disk, as every other workspace file does.

## Overwrite

- An existing target is refused.
- `--force` replaces an existing file with one atomic rename.
- An existing directory target is refused, also with `--force`. Remove it first.

## Limits

- At most 10 GB and 10,000 files per transfer.
- The helper refuses a transfer that would leave the target disk below 20 % free. The launcher refuses a download that does not fit on the Mac.
- A large directory belongs in the session cache: the hourly backup of the state disk fails above 100,000 files.

## Cleanup

- The launcher deletes the object version on every exit after the upload or the call started.
- The helper deletes its temporary file or folder on every failure.
- Two lifecycle rules, on `inputs/transfers/` and `results/transfers/`, remove an object after 1 day, a noncurrent version after 1 day, and an incomplete multipart upload after 1 day. They catch a copy that a failed delete leaves.

## Security

- A file is in S3 only while it moves. S3 keeps it encrypted at rest; the bucket refuses plain HTTP and public access. A principal of the AWS account that can read the bucket can read it while it is there, as with a pasted image or a backup.
- Encryption on the Mac before the upload is not part of this design.
- Tokiwa enforces the allowed folders, the limits and the checks. Whether a person or an agent may run `tokiwa cp`, and in which direction, is decided by the owner's permission rules outside Tokiwa.
- Each transfer adds one line to the audit log of the host: the direction, the resolved path, the files, the bytes, the SHA-256 and the actor.

## Long transfers

The launcher sets the `executionTimeout` of the call from the size, and waits until the call ends. The slow leg is the link of the Mac; the progress of `aws s3 cp` shows there. Between S3 and the host the copy is fast.

## Alternatives considered

- SSH or SCP over Session Manager: needs `sshd` and keys on the host.
- Bytes through the terminal session: slow, and it breaks binary data.
- Presigned links only: the CLI cannot make a presigned PUT, and a presigned PUT carries at most 5 GB.
- Git: not general enough.

## Changes this needs

- Launcher: a `cp` mode.
- Host helper: two modes, one to receive and one to send, as the session user.
- Root step in the Run Command line: the `boto3` copy between the object and the pipe.
- Bucket: the two lifecycle rules.
- Docs: the command reference, and the limits and security of a transfer.

## Tests

- Upload and download of a file and of a directory, with the checksum checked on both sides.
- Refusals: an existing target, an existing directory with `--force`, a path outside the allowed folders, the private volume, a symbolic link that leaves an allowed folder, a tar stream with `..`, an absolute name or a device, a transfer over the limits, a disk that would drop below 20 % free.
- A failure at each step leaves no file at the target and no object in S3.
- A key outside the two prefixes is refused on the host.
