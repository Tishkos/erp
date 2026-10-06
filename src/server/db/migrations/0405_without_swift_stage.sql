-- An import bought with an advance waits in a warehouse of its own until the
-- advance is paid (2026-10-06, by direction: "the advanced option has one
-- extra warehouse, On Process (Without SWIFT) … once its payment application is
-- done it goes In Process and continues like other applications").
--
-- A value added to an enum is committed before a later migration may use it,
-- so this file holds nothing else (`migrate.ts` › `migrateInSteps`).
ALTER TYPE "public"."shipment_stage" ADD VALUE IF NOT EXISTS 'without_swift' BEFORE 'in_process';
