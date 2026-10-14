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

Database selection and scheduled tasks are unchanged. Protected restoration is
described below; full recovery readiness still depends on startup and the
authoritative database decision.

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
durability guarantees. Authoritative pilot database selection and fresh-database
startup remain outstanding; these changes do not certify overall recovery.

Reference: [SQLite online backup API](https://www.sqlite.org/backup.html).

## Protected Windows restoration (103B-3)

`node scripts/restore-backup.js <backup.db.enc|backup.db> [--force]` accepts the
existing encrypted format and standalone plaintext backups. Stop the application,
close all database tools, and keep the destination offline until restoration
finishes. An existing destination still requires `--force`; this is overwrite
authorization, not permission to replace a live database.

The CLI authenticates encrypted bytes, writes only to a unique
`.lexflow-restore-…` directory next to the destination, checks SQLite's header and
integrity, and requires these core baseline tables/columns:

- users: id, email, password, fullName, role
- clients: id, name
- matters: id, reference, clientId, title
- time_entries: id, matterId, hours
- invoices: id, matterId, amount
- firm_settings: id, name

This is a minimum compatibility check, not validation of every route, migration
or business record. Audit insertion occurs in the staged database with actual
callback errors propagated. A failed insertion aborts before replacement; no
successful audit is reported. The staged journal is converted to DELETE mode,
handles are closed, and integrity/schema are checked again before publication.

A Windows PowerShell helper obtains a per-destination restore lock and opens
every existing main/sidecar file with reader/writer sharing denied and rename
sharing allowed. An active SQLite or ordinary file handle prevents replacement.
Main, `-wal`, `-shm`, `-journal`, and legacy `-wal.db`/`-shm.db` files are moved to
an operation-owned rollback directory on the same volume, while leases stay
held. The validated staged file is then moved into place without overwriting a
newly appeared file. Originals are retained until publication completes.

Replacement errors trigger reverse moves to recover original paths. Successful
recovery permits cleanup of the operation-owned staging directory. Incomplete
recovery or an unknown helper outcome exits nonzero and retains the directory
and recovery.json; its explicit location is printed. Keep the application offline
and inspect those preserved files before any new restore attempt. Never treat a
retained directory as a completed restore or delete it blindly. Successful
publication reports the restore/audit only after the helper returns success.

This is protected, recoverable replacement, not an atomic transaction across
multiple filenames. Abrupt process termination, power loss, OS failure and an
application deliberately restarted during the rename window are not covered by
an automatic rollback guarantee. The Windows leases protect currently existing
files; the maintenance requirement prevents new database creation while names
are moved. No portable-platform fallback bypasses these protections. Same-volume
staging inherits the parent directory's permissions; protect those permissions.

Reference: [Windows FileShare semantics](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare).
