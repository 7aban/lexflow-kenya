# Backup verification and publication

The backup CLI creates a temporary `.lexflow-stage-…` artifact, verifies its
decryption and SQLite integrity, and only then publishes the existing
`lawfirm-YYYYMMDD-HHMMSSmmm.db.enc` (or `.db`) filename. The encryption bytes and
valid legacy backup format are unchanged. Publication requires same-directory
hard-link support and fails without overwriting an existing filename.

Verification failure returns exit code 1 with its actual reason. It does not
publish, rotate older backups, emit a success message or insert `backup_created`.
Cleanup targets only the current operation's owned artifact. A best-effort
`backup_failed` audit stores the phase and reason; audit errors are reported.
An audit insertion error is never reported as a successful insertion. Success
audit errors remain explicitly non-fatal when the backup itself was verified.

After successful publication, retention uses the existing configured count and
verifies published candidates before counting or deleting them. Unverifiable
historical artifacts and unpublished staging files are preserved and excluded
from that count. An interrupted operation may leave a staging file; it is not a
published backup and must not be treated as verified. Successful audit metadata
contains the actual verification result.

This contract does not certify safe restore. The restore defect remains separate:
restore currently replaces its destination
before SQLite validation. Database selection, scheduled tasks and restore
semantics are unchanged.

## Consistent SQLite snapshots (103B-2)

Backup creation now uses the installed driver's native SQLite online backup API,
not a WAL checkpoint followed by reading the main database file. A dedicated
read-only connection begins a transaction and reads the schema to establish its
snapshot boundary. The copy proceeds in 128-page steps against that pinned view.
Committed records visible when that read begins are included, even if a separate
reader holds an older WAL view. Transactions committed afterward are outside
this snapshot; they need not appear in it. In WAL mode a writer can continue
committing while the pinned copy proceeds. Rollback-journal writers may instead
wait for the snapshot's read transaction to close.

A unique `.lexflow-snapshot-…` directory inside the configured backup directory
owns the temporary plaintext SQLite image and sidecars. After native completion
is checked and handles are closed, that image feeds stage → verify → publish.
The plaintext directory is removed before verification/publication. Copy errors,
BUSY/LOCKED, incomplete completion and the 90-second snapshot deadline fail the
operation; no fallback main-file copy, publication or rotation occurs. The
deadline is checked between queued native calls and after each copy step; it
does not forcibly cancel filesystem/native work mid-call. Cleanup waits for
native callbacks and handle closure. The source uses a one-second busy timeout.

Only the current operation's unique directory is cleaned. Forced termination or
power loss can leave an unpublished plaintext staging directory; it remains
outside retention and requires controlled manual cleanup. Protect the backup
directory's Windows permissions accordingly. Staging does not provide crash
durability guarantees. Safe staged restoration and authoritative pilot database
selection remain outstanding; this change does not certify overall recovery.

Reference: [SQLite online backup API](https://www.sqlite.org/backup.html).
