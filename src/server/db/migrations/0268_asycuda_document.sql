-- IMPROVEMENT-002 — the ASYCUDA reading as a document (sponsor, 2026-10-03:
-- "a table like other pages … a new ASYCUDA document … add the attachment").
--
--   * Every reading of the ASYCUDA list is a numbered document, ASY-{YYYY}-
--     {SERIAL}: the register lists them, each opens on its own page with the
--     list as ASYCUDA gave it and what applying it changes.
--   * The file it was read from is filed on it (attachments, object
--     `asycuda_run`), so "which export did we act on?" is answered by opening
--     the document.
--   * The people who work the customs lane file paperwork: the customs and
--     logistics officers gain the attachment grants (they had none, so a PD
--     scan or a container's delivery note could not be filed by them), and the
--     CEO reads attachments.
--   * A reading prints like any other document: whoever may read the list
--     into the PDs (`import` on customs_pd) may print and export it.
ALTER TABLE "asycuda_run" ADD COLUMN IF NOT EXISTS "run_no" text;--> statement-breakpoint
UPDATE "asycuda_run" r
   SET "run_no" = 'ASY-' || to_char(r.read_at AT TIME ZONE 'Asia/Baghdad', 'YYYY') || '-' || lpad(n.serial::text, 5, '0')
  FROM (SELECT id, row_number() OVER (PARTITION BY date_part('year', read_at AT TIME ZONE 'Asia/Baghdad') ORDER BY read_at, id) AS serial
          FROM "asycuda_run") n
 WHERE n.id = r.id AND r.run_no IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "asycuda_run_no_uniq" ON "asycuda_run" ("run_no") WHERE "run_no" IS NOT NULL;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('ASYCUDA_RUN', 'ASY', '{PREFIX}-{YYYY}-{SERIAL}', 5, false, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

-- The numbers already given by the backfill are not handed out again.
DO $$
DECLARE
	year_row record;
	seq text;
BEGIN
	FOR year_row IN
		SELECT date_part('year', read_at AT TIME ZONE 'Asia/Baghdad')::int AS yr, count(*) AS n FROM asycuda_run GROUP BY 1
	LOOP
		seq := doc_sequence_name('ASYCUDA_RUN', year_row.yr::text);
		IF to_regclass(seq) IS NULL THEN
			EXECUTE format('CREATE SEQUENCE %I START 1', seq);
		END IF;
		PERFORM setval(seq, year_row.n, true);
	END LOOP;
END $$;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('customs_officer',   'attachment', 'view'),
	('customs_officer',   'attachment', 'create'),
	('logistics_officer', 'attachment', 'view'),
	('logistics_officer', 'attachment', 'create'),
	('ceo',               'attachment', 'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT g.role_code, 'customs_pd', v.verb
  FROM role_grant g
 CROSS JOIN unnest(ARRAY['print', 'export']::permission_verb[]) AS v(verb)
 WHERE g.object = 'customs_pd' AND g.verb = 'import'
ON CONFLICT DO NOTHING;
