-- Extend the sf_what_type enum so activities can link to Salesforce
-- Campaigns as well as Opportunity / Account. SF Event.WhatId natively
-- accepts Campaign, so writeback works without further schema changes —
-- the enum was the only gate.
ALTER TYPE sf_what_type ADD VALUE IF NOT EXISTS 'Campaign';
