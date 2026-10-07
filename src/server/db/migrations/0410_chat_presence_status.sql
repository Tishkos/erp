-- 0410 — the status a person chooses in the account menu (2026-10-06, by
-- direction: "in drop down there should be an option please available busy
-- away offline mode").
--
-- `chat_presence` (0310) kept a heartbeat and one flag, `busy`. A person now
-- chooses one of four, kept until they change it:
--
--   available   Online while at the page, Away after five idle minutes
--   busy        Busy (red), and no message sounds
--   away        Away (amber), however active
--   invisible   "Appear offline": everybody else sees Offline and no "last
--               seen"; they still receive everything
--
-- What others are shown is still worked out when read (`domain/chat.ts` ›
-- `presenceOf`), never stored. `busy` stays and follows the status
-- (`services/chat.ts` › `setStatus`), so what reads the flag still agrees; a
-- row that was busy before this becomes 'busy'. The policies of 0310 (you
-- write only your own row) cover the new column.

ALTER TABLE "chat_presence" ADD COLUMN "status" text NOT NULL DEFAULT 'available';--> statement-breakpoint
ALTER TABLE "chat_presence" ADD CONSTRAINT "chat_presence_status_known"
	CHECK ("status" IN ('available', 'busy', 'away', 'invisible'));--> statement-breakpoint
UPDATE "chat_presence" SET "status" = 'busy' WHERE "busy";
