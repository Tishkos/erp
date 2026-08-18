-- ---------------------------------------------------------------------------
-- D16, the last piece — one register, one document type, one sequence.
--
-- 0153 merged the tables. Two things still described the vanished one: a
-- `document_type` row and its `role_grant` entries, which is what §5.3 checks a
-- user against. Leaving them would mean a Logistics clerk holding permissions on
-- a document that no longer exists, and holding none on the one that replaced
-- it — a permission model that reads as intact and grants nothing.
--
-- The verbs are merged as a union rather than replaced. Logistics held `print`
-- and `configure` that Money Transfer did not; Money Transfer held
-- `reverse_cancel` that Logistics did not. Both services still do the work those
-- verbs describe, so both keep them: narrowing a grant silently is how a control
-- becomes an outage three weeks later.
-- ---------------------------------------------------------------------------

INSERT INTO role_grant (role_code, object, verb)
SELECT g.role_code, 'client_import_file', g.verb
  FROM role_grant g
 WHERE g.object = 'logistics_client_import_file'
ON CONFLICT DO NOTHING;--> statement-breakpoint

DELETE FROM role_grant WHERE object = 'logistics_client_import_file';--> statement-breakpoint

-- The surviving description says what the register now is, rather than what
-- Money Transfer alone once used it for.
UPDATE document_type
   SET name = 'Client Import File',
       description = 'The client''s import consignment: one register for both services (D16, 2026-08-18). A Logistics Job and a Money Transfer can both name the same file - blueprint 11 says so in its first paragraph - and neither combines its accounting with the other. The file carries no amount, and client_import_file_reference, where the two services meet, has no amount column at all.'
 WHERE code = 'client_import_file';--> statement-breakpoint

DELETE FROM document_type_controlled_field
 WHERE document_type_code = 'logistics_client_import_file';--> statement-breakpoint

DELETE FROM document_status_transition
 WHERE document_type_code = 'logistics_client_import_file';--> statement-breakpoint

DELETE FROM document_type WHERE code = 'logistics_client_import_file';--> statement-breakpoint

-- 0153 deactivated the duplicate sequence. Nothing may draw from it again: one
-- register mints from one counter, or the numbers collide the way they already
-- silently did.
UPDATE doc_sequence
   SET active = false
 WHERE key = 'LOGISTICS_CLIENT_IMPORT_FILE';
