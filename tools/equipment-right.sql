-- Lets the Team page grant the new "Edit equipment purchases" right. Run ONCE in the Supabase SQL editor. Safe to re-run.
-- It only widens the list of allowed rights by one word ("equipment"). Nothing else about rights changes.
do $$
declare
  cname text; def text; fdef text;
begin
  -- 1) the table rule that limits which rights can be stored
  select conname, pg_get_constraintdef(oid) into cname, def
  from pg_constraint
  where conrelid = 'public.staff_rights'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%permission%'
  limit 1;
  if cname is not null and def not like '%equipment%' then
    execute format('alter table public.staff_rights drop constraint %I', cname);
    execute format('alter table public.staff_rights add constraint %I %s', cname,
                   replace(def, 'ARRAY[', 'ARRAY[''equipment''::text, '));
  end if;

  -- 2) the set_right function: same code, with "equipment" added to its allowed list
  select pg_get_functiondef(p.oid) into fdef
  from pg_proc p where p.proname = 'set_right' and p.pronamespace = 'public'::regnamespace;
  if fdef is not null and fdef not like '%equipment%' then
    if position($q$('delete','activity','extra_work')$q$ in fdef) = 0 then
      raise exception 'set_right looks different than expected - nothing was changed';
    end if;
    execute replace(fdef, $q$('delete','activity','extra_work')$q$, $q$('delete','activity','extra_work','equipment')$q$);
  end if;
end $$;
