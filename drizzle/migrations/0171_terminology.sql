-- v1.446.0: Admin → Workplace → Terminology. Fresh installs default to POx
-- ("POx Work"). An install that already has the old "Eval Work" Activity Type
-- is pinned to Eval here, so upgrading renames nothing; an App Admin who picks
-- another term later gets the rename then, with the CRM picklist value kept.
INSERT INTO "system_settings" ("key", "value")
SELECT 'terminology', '{"evalTerm":"eval","customEvalTerm":null}'::jsonb
WHERE EXISTS (SELECT 1 FROM "team_activity_types" WHERE "name" = 'Eval Work')
ON CONFLICT ("key") DO NOTHING;
