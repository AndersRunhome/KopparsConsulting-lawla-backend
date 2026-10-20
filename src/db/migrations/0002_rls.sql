-- Radnivåsäkerhet på alla tabeller. Backendet ansluter som tabellägare och påverkas inte;
-- andra roller (t.ex. Supabases anon/authenticated via PostgREST) ser ingenting.
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
