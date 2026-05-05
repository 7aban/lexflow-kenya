# LexFlow Access Control Model

## Overview
This document describes the access control model for LexFlow, the Kenyan law practice management application. It defines how users with different roles can access clients, matters, documents, invoices, tasks, appearances, and other resources.

## Roles and Permissions

### Admin
- **Can access**: Firm-wide clients, matters, invoices, documents, tasks, appearances, audit logs, dashboard/performance data
- **Can manage**: Users/settings (where supported)
- **Audit logs**: `GET /api/audit-logs` and `GET /api/audit-events` are admin-only

### Advocate
- **Can access**: Own/assigned matters and related clients/documents/invoices/tasks/appearances
- **Cannot access**: Other advocates' private matter data unless explicitly assigned or allowed by firm policy
- **Cannot access**: Audit logs (admin-only)
- **Dashboard**: Sees only own/assigned data

### Assistant/Staff
- **Can access**: Operational data only within permitted firm scope
- **Cannot access**: Admin-level audit access, privileged admin/security settings
- **Note**: Current app treats staff as broad internal staff

### Client
- **Can access**: Only own client portal data
- **Can access**: Only documents/messages/invoices/notices exposed to that client
- **Cannot access**: Internal case notes, audit logs, staff/admin dashboards, firm-wide search, or other clients' data

## Access Control Implementation

### Helper Functions (server/lib/access.js)

The following helper functions are available for checking access:

- `canAccessMatter(req, matterId)` - Check if user can access a matter
- `canAccessClient(req, clientId)` - Check if user can access a client
- `canAccessInvoice(req, invoiceId)` - Check if user can access an invoice
- `canAccessTask(req, taskId)` - Check if user can access a task
- `canAccessTimeEntry(req, entryId)` - Check if user can access a time entry
- `canAccessAppearance(req, appearanceId)` - Check if user can access an appearance
- `canAccessNotice(req, noticeId)` - Check if user can access a notice
- `canAccessConversation(req, conversationId)` - Check if user can access a conversation
- `canAccessDocument(req, doc)` - Check if user can access a document (pass the document object)

### Matter Scoping
- `GET /api/matters` - Returns matters based on role:
  - Client: Only their own matters
  - Advocate: Only matters assigned to them (via `assignedTo` field)
  - Admin/Staff: All matters

- `GET /api/matters/:id` - Checks `canAccessMatter()` for all roles
- `PATCH /api/matters/:id` - Checks `canAccessMatter()` for advocates
- `DELETE /api/matters/:id` - Checks `canAccessMatter()` for advocates
- `PATCH /api/matters/:id/status` - Checks `canAccessMatter()` for advocates

### Client Portal Isolation
- `GET /api/client/dashboard` - Client-only, returns only own data
- `GET /api/matters` - Client sees only their matters
- `GET /api/matters/:id` - Client can only access their own matters
- `GET /api/matters/:id/documents` - Client sees only client-visible documents
- `GET /api/invoices` - Client sees only their invoices
- `GET /api/invoices/:id` - Client can only access their own invoices
- `GET /api/invoices/:id/pdf` - Client can only access their own invoice PDFs
- `GET /api/notices` - Client sees only notices targeted to them or broadcast notices

### Document Visibility
- `GET /api/documents/:id/download` - Uses `canAccessDocument()` for all roles
- `GET /api/matters/:id/documents` - Client sees only documents where:
  - `source='client'` OR
  - `clientVisible=1` OR
  - Document is linked to a message in a conversation the client can access
- Staff can access all documents for matters they can access

### Invoice Access
- `GET /api/invoices` - Returns invoices based on role:
  - Client: Only their invoices
  - Advocate: Only invoices for matters assigned to them
  - Admin/Staff: All invoices

- `GET /api/invoices/:id` - Uses `canAccessInvoice()` for all roles
- `GET /api/invoices/:id/pdf` - Uses `canAccessInvoice()` for all roles
- `DELETE /api/invoices/:id` - Uses `canAccessInvoice()` for advocates

### Search Scoping
- `GET /api/search` - Requires staff access (client cannot access)
- Advocate search returns only results from their assigned matters

### Dashboard/Performance
- `GET /api/dashboard` - Returns role-specific data:
  - Advocate: Only their assigned matters' data
  - Admin/Staff: Firm-wide data

- `GET /api/performance/advocates` - Admin-only (firm-wide performance)
- `GET /api/performance/advocates/:userId` - Admin-only

### Audit Logs
- `GET /api/audit-logs` - Admin-only (`requireAdmin` middleware)
- `GET /api/audit-events` - Admin-only (`requireAdmin` middleware)

### Forbidden Access Audit Events
When a user attempts to access a resource they don't have permission for, a forbidden access audit event is recorded (where practical):

- `forbidden_matter_access` - Matter access denied
- `forbidden_invoice_access` - Invoice access denied
- `forbidden_task_access` - Task access denied
- `forbidden_time_entry_access` - Time entry access denied
- `forbidden_appearance_access` - Appearance access denied
- `forbidden_document_access` - Document access denied

These events include:
- Actor user ID, role, and email
- Action type (e.g., `forbidden_matter_access`)
- Entity type and ID
- Reason: "insufficient permissions"
- IP address and user agent (for security tracking)
- Timestamp

**Important**: Audit failure does not break authorization denial.

## Future AI/Automation Notes

Any AI assistant, automation, or recommendation system must:

1. **Use the same permission helpers** (`canAccessMatter`, `canAccessInvoice`, etc.) from `server/lib/access.js`
2. **Never bypass role/matter/client boundaries**
3. **Never create bypass routes** that could be exploited
4. **Inherit these exact boundaries** - the access model defined here
5. **Respect the same scoping rules** for queries (advocate sees only assigned matters, client sees only their data)

### AI-Specific Guidelines
- When accessing matters: Use `scopeMattersQuery()` or `canAccessMatter()`
- When accessing documents: Use `canAccessDocument()` and respect `clientVisible` flag
- When searching: Apply the same scoping as `GET /api/search`
- When generating reports: Respect role-based data access (advocate sees own data only)
- Never expose: Internal case notes to clients, other clients' data, audit logs to non-admins

## Security Considerations

1. **No authentication bypass**: All API routes require authentication via `authenticate` middleware (applied at `app.use('/api', authenticate)`)
2. **No client-to-staff escalation**: Clients cannot access staff routes (enforced by `requireStaff`, `requireAdvocateOrAdmin`, `requireAdmin` middleware)
3. **Matter assignment matters**: Advocates can only access matters assigned to them via `assignedTo` field
4. **Client isolation**: Clients can only access their own data (clientId matching)
5. **Audit trail**: Forbidden access attempts are logged (without exposing sensitive content)
6. **No schema changes**: Access control is enforced at the application layer, not the database layer

## Testing

Access control is tested in:
- `test/access-control.test.js` - Main access control tests
- `test/roles-search.test.js` - Role scoping and search tests
- `test/documents-client.test.js` - Document visibility and client portal tests
- `test/client-dashboard.test.js` - Client dashboard isolation tests

Run tests with: `cd server && npm test`
