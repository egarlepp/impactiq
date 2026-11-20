-- v1.167.0: remove redundant ARCHIVED activity duplicates that share an
-- (user_id, outlook_event_id) with a still-active activity. These accumulated
-- because approve/create dedup only matched non-archived rows, so a
-- delete-then-re-approve cycle left the old row archived and inserted a fresh
-- duplicate. Only archived rows that have an ACTIVE sibling for the same
-- (user, Outlook event) are removed, so no meeting ever loses its only record.
-- Child rows (notes, products, sync audit, note pushes) cascade on delete.
DELETE FROM activities AS a
WHERE a.is_archived = true
  AND a.outlook_event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM activities b
    WHERE b.user_id = a.user_id
      AND b.outlook_event_id = a.outlook_event_id
      AND b.is_archived = false
  );
