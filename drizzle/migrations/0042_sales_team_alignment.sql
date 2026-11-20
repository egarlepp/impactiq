-- Sales Team Alignment: cache of Salesforce Users we've observed + a
-- many-to-many table linking ImpactIQ users to the SF Managers/Owners
-- they support. Drives the Sales Team Breakdown dashboard.
CREATE TYPE sf_alignment_role AS ENUM ('manager', 'owner');

CREATE TABLE sf_users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text,
  manager_id text REFERENCES sf_users(id),
  is_active boolean DEFAULT true NOT NULL,
  last_synced_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX sf_users_manager_id_idx ON sf_users(manager_id);
CREATE INDEX sf_users_name_idx ON sf_users(lower(name));
CREATE INDEX sf_users_email_idx ON sf_users(lower(email));

CREATE TABLE sf_user_alignments (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sf_user_id text NOT NULL REFERENCES sf_users(id) ON DELETE CASCADE,
  role sf_alignment_role NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (user_id, sf_user_id, role)
);

CREATE INDEX sf_user_alignments_user_id_idx ON sf_user_alignments(user_id);
CREATE INDEX sf_user_alignments_sf_user_id_idx ON sf_user_alignments(sf_user_id);
