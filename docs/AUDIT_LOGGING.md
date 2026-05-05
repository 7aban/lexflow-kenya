# LexFlow Audit Logging

## Overview

LexFlow implements structured audit logging to create a secure, tamper-evident activity trail. This foundation supports:
- Legal-practice accountability
- Compliance with Kenyan legal practice requirements
- Future AI/assistant features (with proper safeguards)

## Audit Tables

### audit_events (New - Primary)
The main audit event table with comprehensive metadata:

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Unique identifier (AUD*) |
| `timestamp` | TEXT NOT NULL | ISO 8601 timestamp |
| `actor_user_id` | TEXT | User who performed the action |
| `actor_role` | TEXT | Role: admin, advocate, assistant, client |
| `actor_email` | TEXT | Email of the actor |
| `action` | TEXT NOT NULL | Action performed (see list below) |
| `entity_type` | TEXT | Type of entity affected |
| `entity_id` | TEXT | ID of entity affected |
| `matter_id` | TEXT | Related matter (if applicable) |
| `client_id` | TEXT | Related client (if applicable) |
| `ip_address` | TEXT | IP address of request |
| `user_agent` | TEXT | User agent string |
| `metadata_json` | TEXT | Additional structured data (JSON) |
| `created_at` | TEXT DEFAULT CURRENT_TIMESTAMP | Record creation time |

### audit_logs (Legacy - Still Used)
The original audit table (simplified):

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Unique identifier (AUD*) |
| `userId` | TEXT | User ID |
| `userName` | TEXT | User display name |
| `role` | TEXT | User role |
| `action` | TEXT | Action performed |
| `entityType` | TEXT | Entity type |
| `entityId` | TEXT | Entity ID |
| `summary` | TEXT | Human-readable summary |
| `createdAt` | TEXT | Timestamp |

### client_activity
Client-facing activity (visible to clients via portal):

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Unique identifier (CACT*) |
| `clientId` | TEXT | Client ID |
| `matterId` | TEXT | Related matter |
| `userId` | TEXT | User who performed action |
| `action` | TEXT | Action type |
| `summary` | TEXT | Summary |
| `entityType` | TEXT | Entity type |
| `entityId` | TEXT | Entity ID |
| `createdAt` | TEXT | Timestamp |

## Logged Actions

### Authentication
| Action | Description |
|--------|-------------|
| `login_success` | Successful login |
| `login_failure` | Failed login attempt |
| `user_registered` | New user registered |
| `invitation_created` | Client invitation sent |
| `invitation_accepted` | Invitation accepted |

### Client Operations
| Action | Description |
|--------|-------------|
| `client_created` | New client added |
| `client_updated` | Client details updated |
| `client_deleted` | Client deleted |

### Matter Operations
| Action | Description |
|--------|-------------|
| `matter_created` | New matter opened |
| `matter_updated` | Matter details changed |
| `matter_archived` | Matter archived/closed |

### Document Operations
| Action | Description |
|--------|-------------|
| `document_uploaded` | Document uploaded |
| `document_deleted` | Document deleted |
| `document_visibility_changed` | Client visibility toggled |
| `document_downloaded` | Document downloaded |

### Invoice Operations
| Action | Description |
|--------|-------------|
| `invoice_generated` | Invoice generated |
| `invoice_updated` | Invoice modified |
| `invoice_marked_paid` | Invoice marked as paid |
| `invoice_pdf_downloaded` | Invoice PDF downloaded |

### Task/Deadline Operations
| Action | Description |
|--------|-------------|
| `task_created` | New task created |
| `task_completed` | Task marked complete |
| `reminder_created` | Reminder set |
| `appearance_created` | Court appearance scheduled |
| `deadline_created` | Deadline added |

## What is NOT Logged (Privacy Protection)

To protect confidentiality, the following are **never** logged:
- Passwords (in any form)
- JWT tokens
- Full document text/content
- Full client messages
- Legal advice text
- Uploaded file contents
- Confidential narrative details
- Sensitive case strategies

## Admin-Only Access

### GET /api/audit-events

**Access:** Admin only

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `actor_user_id` | TEXT | Filter by user |
| `action` | TEXT | Filter by action type |
| `entity_type` | TEXT | Filter by entity type |
| `entity_id` | TEXT | Filter by entity ID |
| `matter_id` | TEXT | Filter by matter |
| `client_id` | TEXT | Filter by client |
| `limit` | INTEGER | Results per page (max 200, default 50) |
| `offset` | INTEGER | Pagination offset (default 0) |

**Response:**
```json
{
  "rows": [
    {
      "id": "AUD123",
      "timestamp": "2026-05-05T10:30:00.000Z",
      "actor_user_id": "U1",
      "actor_role": "admin",
      "actor_email": "admin@lexflow.co.ke",
      "action": "login_success",
      "entity_type": "user",
      "entity_id": "U1",
      "matter_id": "",
      "client_id": "",
      "ip_address": "127.0.0.1",
      "user_agent": "Mozilla/5.0...",
      "metadata_json": "{\"email\":\"admin@lexflow.co.ke\",\"role\":\"admin\"}"
    }
  ],
  "total": 150,
  "limit": 50,
  "offset": 0
}
```

### GET /api/audit-logs (Legacy)

Same as above but uses `audit_logs` table with simplified fields.

## Using the Audit Helper

### In Route Handlers

```javascript
const { recordAuditEvent } = createAudit({ run, get });

// In your route:
app.post('/api/something', authenticate, async (req, res) => {
  // ... do work ...
  
  // Log the action
  await recordAuditEvent(req, {
    action: 'something_created',
    entityType: 'something',
    entityId: newSomething.id,
    matterId: req.body.matterId || '',
    metadata: { key: 'value' } // Optional additional data
  }).catch(() => {}); // Fail-soft - don't crash request
  
  res.json(newSomething);
});
```

### Metadata Guidelines

**DO include:**
- IDs of related entities
- Non-sensitive status changes
- Counts/summaries (not detailed data)
- Actor information (already captured automatically)

**DO NOT include:**
- Sensitive content (see "What is NOT Logged" above)
- Large data structures
- Full request bodies
- File contents

## Audit Helper Functions

### recordAuditEvent(req, { action, entityType, entityId, matterId, clientId, metadata })

Records a structured audit event.

**Parameters:**
- `req` - Express request object (for actor info, IP, user agent)
- `action` - Action type (e.g., 'client_created')
- `entityType` - Type of entity (e.g., 'client')
- `entityId` - ID of entity affected
- `matterId` - Related matter ID (optional)
- `clientId` - Related client ID (optional)
- `metadata` - Additional structured data (optional, JSON-serializable)

**Behavior:**
- Safely extracts actor info from `req.user`
- Captures IP address and user agent
- Redacts sensitive fields from metadata
- Fails soft (doesn't crash the request)
- Creates `audit_events` table if it doesn't exist

### getIpAddress(req)

Extracts IP address from request (checks `x-forwarded-for`, `req.ip`, `req.socket.remoteAddress`).

### getUserAgent(req)

Extracts user agent string from request headers.

## Configuration

No additional environment variables required for basic audit logging.

Optional settings in `server/.env`:
```bash
# Audit log retention (future feature)
AUDIT_RETENTION_DAYS=365

# Enable audit log export (future feature)
AUDIT_EXPORT_ENABLED=true
```

## AI-Readiness Architecture Note

The audit/activity event system is designed to support **future safe intelligence features**, including:

### Planned Features (NOT YET IMPLEMENTED)
1. **Matter Activity Summaries**
   - AI-generated summaries of matter activity from audit events
   - Must respect role-based and matter-based access
   - Clients only see their own matters
   - Staff see assigned matters only

2. **User Preference Learning**
   - Learn user work patterns from audit events
   - Preferred document types, billing rates, reminder channels
   - Must be opt-in/opt-out
   - Users control their own preference data

3. **Workflow Suggestions**
   - Suggest next steps based on similar matters
   - Deadline risk detection from historical data
   - Billing anomaly flags

4. **Drafting Style Preferences**
   - Learn document styling from audit of document uploads
   - Apply to future document generation

### Future Safeguards (Will Be Implemented)
- **Opt-in/opt-out controls** for each AI feature
- **Role-based and matter-based access enforcement** - no cross-client leakage
- **User-visible preference management** UI
- **Human approval** before external communications or record changes
- **Data minimization** - only metadata used, never full content
- **Audit trail for AI actions** - all AI operations logged

## Testing

Audit logging is tested:
- `audit_events` table exists or initializes safely
- `recordAuditEvent` inserts a safe event
- Sensitive metadata fields are redacted
- Admin can access `GET /api/audit-events`
- Non-admins cannot access audit endpoints
- Key actions create audit events (login, client creation, etc.)

## Troubleshooting

### "Audit logging failed: no such table"
- Normal in test environment
- Table is created automatically on first insert
- Does not crash the main request

### Audit events not appearing
1. Check user has admin role
2. Verify `recordAuditEvent` is called in the route
3. Check `audit_events` table: `SELECT * FROM audit_events ORDER BY timestamp DESC LIMIT 10;`

### Sensitive data in metadata
- Metadata is automatically redacted
- Check `redactSensitive()` function in `server/lib/audit.js`
- Redacted fields show as `[REDACTED]`

## File Locations

| File | Purpose |
|------|---------|
| `server/lib/audit.js` | Audit helper functions |
| `server/server.js` | Initializes audit, defines endpoints |
| `docs/AUDIT_LOGGING.md` | This documentation |
| `server/lib/logging.js` | Legacy `logAudit()` function |

## Migration Notes

- `audit_events` table is created automatically on first use
- No migration needed - `CREATE TABLE IF NOT EXISTS` is used
- Existing `audit_logs` table still works (backward compatible)
- Both tables can coexist during transition
