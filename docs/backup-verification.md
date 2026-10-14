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

This contract does not certify WAL snapshot freshness or safe restore. The
checkpoint/raw-copy consistency defect and restore's destination replacement
before SQLite validation remain separate repair phases. Database selection,
scheduled tasks and restore semantics are unchanged.
