# Communications and notifications access boundary (100C)

Matter-linked conversations require the advocate's existing matter assignment. Access to a shared client through a different matter, or delegation to a task/appearance, cannot grant the conversation. Genuinely matterless conversations use the established client-access rule from 100B: the advocate must have an accessible matter for that client. Missing or mismatched matter links do not become general enquiries. Admins and assistants retain firm-wide intake, read, reply and triage. Clients retain their existing own-conversation portal policy.

`communicationAccessScopeSql` centralizes that policy for lists, summary aggregation, resource checks, and stored notifications. Conversation creation resolves the actual persisted matter/client association before checking access. Mark-read, status changes, message reads/replies and sender avatars all use the corrected shared conversation helper. Rejected writes stop before business changes and success audits.

Message attachment metadata is scoped in SQL before ordering. Advocates must have both the conversation and any attached document's matter permission, including when legacy records contain conflicting links. Downloads use the same shared attachment scope. Client attachment semantics and ordinary matter-document, notice, lifecycle and Explorer behavior remain unchanged.

The notification utility resolves persisted matter/client associations and filters recipients through the same communication rule. This covers client-message previews, general enquiries, client uploads, document-request responses and existing client-note notifications. Admin and assistant recipients remain. Invalid or missing resource associations are not broadcast. Notification types, preview text and delivery semantics are otherwise unchanged.

Stored notifications are reauthorized on every list request before ordering and the 50-row limit. Records outside current access are omitted entirely, including preview text and joined client/matter metadata. Notification mark-read also enforces current access while retaining the existing per-recipient ownership rule. Assignment loss, client reassociation and missing resources cannot make stale previews visible. No schema change is needed; existing matter/client notification links are used.

Validation uses isolated synthetic databases with two advocates, shared/separate clients, matterless and broken-link cases, client isolation, attachments and avatars, notification creation through every existing producer, historical notification scoping and rejected-write state/audit checks. Focused browser tests exercise existing staff inbox and portal messaging components. No real pilot database or provider credentials are used.

This phase does not change 100B matter access, deadlines, tasks, appearances, court completion, reminder delivery or sending, provider settings, schema, or communication features.
