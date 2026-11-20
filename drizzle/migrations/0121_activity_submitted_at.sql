-- v1.241.0: activities.submitted_at — when an activity was APPROVED.
--
-- Needed for the "Approved on <date>" tooltip on the green check. None of the
-- existing timestamps answer that question: created_at is when the row
-- appeared (an activity can sit as a draft for days), and updated_at moves on
-- every subsequent edit, so an activity approved in July but edited in August
-- would claim it was approved in August.
ALTER TABLE "activities" ADD COLUMN "submitted_at" timestamptz;

-- Backfill already-approved rows from updated_at. This is an APPROXIMATION and
-- deliberately so: for rows never edited after approval it's exact, and for
-- the rest it's the closest bound available (approval happened at or before
-- updated_at). The alternative — leaving them NULL — would show no date at all
-- on the entire existing history, which is strictly less useful than a date
-- that's right for most rows. Going forward the value is written on the actual
-- transition and is exact.
UPDATE "activities" SET "submitted_at" = "updated_at" WHERE "status" = 'submitted' AND "submitted_at" IS NULL;
