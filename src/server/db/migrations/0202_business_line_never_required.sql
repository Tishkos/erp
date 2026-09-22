-- Business Line is never asked for — by direction, 2026-09-22.
--
-- §4.2 holds the requirement as rows rather than code precisely so that the
-- Business Process Owner can change it without a release, and the sponsor has:
-- *"i dont want business line"*. So the rows go, and with them every place the
-- system could refuse a posting for want of one.
--
-- Three layers, because a requirement can come from any of them (see
-- domain/dimensions.ts): the account type, the account itself, and the
-- document type. Removing one and leaving another is how a rule appears to be
-- gone and then refuses a posting a month later.
--
-- What stays: the business_line master and its six §2.2 names, the column on
-- every journal line, and the dimension registry. A Sales Order that names a
-- line still carries it into its invoice, and the sales invoice records the
-- company's own line without asking — nothing here removes the ability to
-- report by line, only the obligation to answer for one.
DELETE FROM account_type_dimension_default WHERE dimension = 'business_line';
--> statement-breakpoint
DELETE FROM account_required_dimension WHERE dimension = 'business_line';
--> statement-breakpoint
UPDATE document_type_dimension SET requirement = 'optional' WHERE dimension = 'business_line';
