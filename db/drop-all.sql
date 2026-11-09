-- Wipe this project's tables completely, ready to rebuild from scratch.
--
-- Drops every table and function in the public schema whose name starts with
-- eclypse_ or console_, and nothing else. It finds them by name at run time, so
-- tables added later by migrations are caught too.
--
-- Everything is deleted: employees, projects, jobs, seeded companies. After
-- running this, run db/schema.sql, then db/schema-console.sql, then
-- npm run admin -- setup.

do $$
declare
  r record;
begin
  for r in
    select tablename from pg_tables
    where schemaname = 'public' and (tablename like 'eclypse\_%' or tablename like 'console\_%')
  loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;

  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like 'eclypse\_%' or p.proname like 'console\_%')
  loop
    execute format('drop function if exists %s cascade', r.fn);
  end loop;
end $$;
