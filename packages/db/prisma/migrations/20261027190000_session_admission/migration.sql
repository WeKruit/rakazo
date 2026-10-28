CREATE TABLE session_admission_generations (
  service text PRIMARY KEY CHECK (service IN ('worker-a','worker-b')),
  generation text NOT NULL CHECK (length(generation) BETWEEN 1 AND 128),
  "cutoverId" text NOT NULL DEFAULT 'verified' REFERENCES home_authority_cutover(id),
  CHECK ("cutoverId"='verified')
);
CREATE TABLE session_admissions (
  token text PRIMARY KEY,
  service text NOT NULL CHECK (service IN ('api','worker-a','worker-b')),
  "instanceId" text NOT NULL UNIQUE,
  "observerRole" text NOT NULL,
  generation text NOT NULL,
  "sessionApplicationName" text NOT NULL UNIQUE,
  "reservedSessions" integer NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closing')),
  "cutoverId" text NOT NULL DEFAULT 'verified' REFERENCES home_authority_cutover(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("cutoverId"='verified'),
  CHECK ("reservedSessions" = CASE WHEN service='api' THEN 1 ELSE 5 END)
);
CREATE UNIQUE INDEX session_admission_worker_slot ON session_admissions(service) WHERE service <> 'api';
CREATE TABLE session_admission_connections (
  token text NOT NULL REFERENCES session_admissions(token) ON DELETE CASCADE,
  pid integer NOT NULL,
  "backendStart" timestamptz NOT NULL,
  PRIMARY KEY(token,pid)
);
REVOKE ALL ON session_admission_generations, session_admissions, session_admission_connections FROM PUBLIC;
ALTER TABLE session_admission_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_admission_connections ENABLE ROW LEVEL SECURITY;
-- No actor policies. No expiry or automatic reclaim: crashed reservations stay charged.
CREATE TABLE session_admission_budget (
  id text PRIMARY KEY CHECK (id='global'),
  "totalSessions" integer NOT NULL CHECK ("totalSessions"=15),
  "externalReservedSessions" integer NOT NULL CHECK ("externalReservedSessions" BETWEEN 1 AND 14),
  "replacementToken" text,
  "replacementOwner" text,
  CONSTRAINT session_replacement_owner_pair CHECK (("replacementToken" IS NULL) = ("replacementOwner" IS NULL)),
  "cutoverId" text NOT NULL DEFAULT 'verified' REFERENCES home_authority_cutover(id),
  CHECK ("cutoverId"='verified')
);
REVOKE ALL ON session_admission_budget FROM PUBLIC;
ALTER TABLE session_admission_budget ENABLE ROW LEVEL SECURITY;
