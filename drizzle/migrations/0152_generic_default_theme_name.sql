-- v1.371.0: renamed the default theme an early version of migration 0149
-- seeded under a company-specific name. 0149 now seeds it as 'Default'
-- directly, and every install that ran the old 0149 has already run this
-- rename, so it is kept only as an intentional no-op to hold its journal slot.
SELECT 1;
