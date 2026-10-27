-- Fence old application binaries after per-home, explicitly verified activation.
-- No home is activated by this migration. Tombstones preserve deletion semantics.
CREATE TABLE "home_authority_tombstones" (
  "homeKeyHash" text PRIMARY KEY
);
REVOKE ALL ON "home_authority_tombstones" FROM PUBLIC;
ALTER TABLE "home_authority_tombstones" ENABLE ROW LEVEL SECURITY;
-- No actor policies: only the existing system/table-owner identity may access it.

-- Expose only key retirement existence, not metadata rows or mutation privileges.
-- Invoker triggers must see tombstones even when ordinary actors are denied table access.
CREATE FUNCTION public.home_authority_retired(home_key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM public.home_authority_tombstones
    WHERE "homeKeyHash" = encode(sha256(convert_to(home_key, 'UTF8')), 'hex'))
$$;

CREATE FUNCTION guard_home_authority() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  old_v2 boolean;
  new_v2 boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF public.home_authority_retired(NEW."homeKey") THEN
      RAISE EXCEPTION 'retired authoritative home key cannot be reused';
    END IF;
    IF NEW."homeRevision" LIKE 'v2:%' THEN
      RAISE EXCEPTION 'new homes must be activated through verified migration';
    END IF;
    RETURN NEW;
  END IF;
  old_v2 := OLD."homeRevision" ~ '^v2:[1-9][0-9]{0,14}:[0-9a-f]{64}$';
  new_v2 := NEW."homeRevision" ~ '^v2:[1-9][0-9]{0,14}:[0-9a-f]{64}$';
  IF NEW."homeRevision" LIKE 'v2:%' AND NOT new_v2 THEN
    RAISE EXCEPTION 'invalid authoritative home revision';
  END IF;
  IF old_v2 THEN
    -- Keep publication privileged: the boolean helper is only for collision checks.
    -- Ordinary actors cannot see this row under the metadata table's policy-free RLS.
    IF NOT EXISTS (SELECT 1 FROM public.home_authority_tombstones WHERE "homeKeyHash" = encode(sha256(convert_to(OLD."homeKey", 'UTF8')), 'hex')) THEN
      RAISE EXCEPTION 'authoritative publication requires system metadata access';
    END IF;
    IF NOT new_v2 OR split_part(NEW."homeRevision", ':', 2)::bigint <> split_part(OLD."homeRevision", ':', 2)::bigint + 1 THEN
      RAISE EXCEPTION 'authoritative home requires next generation; legacy or stale writer rejected';
    END IF;
  ELSIF new_v2 THEN
    IF split_part(NEW."homeRevision", ':', 2) <> '1' THEN
      RAISE EXCEPTION 'authoritative home activation must begin at generation one';
    END IF;
    INSERT INTO public.home_authority_tombstones ("homeKeyHash") VALUES (encode(sha256(convert_to(NEW."homeKey", 'UTF8')), 'hex'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER home_authority_insert BEFORE INSERT ON computers FOR EACH ROW EXECUTE FUNCTION guard_home_authority();
CREATE TRIGGER home_authority_revision BEFORE UPDATE OF "homeRevision" ON computers FOR EACH ROW EXECUTE FUNCTION guard_home_authority();
CREATE FUNCTION guard_home_authority_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD."homeRevision" LIKE 'v2:%' AND
    (NEW.id, NEW."homeKey", NEW."userId", NEW."spaceId") IS DISTINCT FROM
    (OLD.id, OLD."homeKey", OLD."userId", OLD."spaceId") THEN
    RAISE EXCEPTION 'authoritative home identity cannot change';
  END IF;
  IF NEW."homeKey" IS DISTINCT FROM OLD."homeKey" AND public.home_authority_retired(NEW."homeKey") THEN
    RAISE EXCEPTION 'retired authoritative home key cannot be reused';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER home_authority_identity BEFORE UPDATE OF id, "homeKey", "userId", "spaceId" ON computers
FOR EACH ROW EXECUTE FUNCTION guard_home_authority_identity();
