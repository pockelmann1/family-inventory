-- Family Inventory database setup.
-- Safe to run more than once. Holds no family data: people, items and photos
-- are loaded later through the one-time import functions.
--
-- Security model
--  * All tables live in schema "app", which the Data API does not expose.
--  * Row-level security is on for every table, and anon/authenticated get no
--    table privileges at all.
--  * The browser can only call the fi_* functions in schema "public". Each one
--    takes the caller's personal link key, checks it against a SHA-256 hash in
--    app.people, and only then reads or writes.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
revoke all on schema app from public;
revoke all on schema app from anon, authenticated;

-- ---------------------------------------------------------------- tables

create table if not exists app.families (
  id    serial primary key,
  name  text not null unique,
  sort  int  not null default 0
);

create table if not exists app.people (
  id             serial primary key,
  family_id      int references app.families(id),
  name           text not null,
  role           text not null check (role in ('sibling', 'child', 'admin')),
  is_admin       boolean not null default false,
  link_key_hash  bytea unique,
  sort           int not null default 0,
  last_seen_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (family_id, name)
);

create table if not exists app.items (
  id           text primary key check (id ~ '^ITEM-[0-9]{4}$'),
  name         text not null,
  room         text not null default '',
  photo_no     text not null default '',
  type         text not null default '',
  subtype      text not null default '',
  origin       text not null default '',
  description  text not null default '',
  hidden       boolean not null default false,
  sort         int not null default 0,
  updated_by   int references app.people(id),
  updated_at   timestamptz not null default now()
);

create table if not exists app.photos (
  id                 uuid primary key default gen_random_uuid(),
  original_drive_id  text unique,
  storage_path       text,
  thumb_path         text,
  width              int,
  height             int,
  full_url           text,
  thumb_url          text,
  urls_expire_at     timestamptz
);

create table if not exists app.item_photos (
  item_id     text not null references app.items(id) on delete cascade,
  photo_id    uuid not null references app.photos(id) on delete cascade,
  sort_order  int  not null default 0,
  primary key (item_id, photo_id)
);

create table if not exists app.rankings (
  person_id   int  not null references app.people(id) on delete cascade,
  item_id     text not null references app.items(id) on delete cascade,
  rank        smallint not null check (rank between 1 and 5),
  updated_at  timestamptz not null default now(),
  primary key (person_id, item_id)
);

create table if not exists app.item_edits (
  id         bigserial primary key,
  item_id    text not null references app.items(id) on delete cascade,
  person_id  int references app.people(id),
  field      text not null,
  old_value  text,
  new_value  text,
  at         timestamptz not null default now()
);

-- One-time import support. Removed from use once the import is finished.
create table if not exists app.import_tokens (
  token_hash  bytea primary key,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists app.photo_staging (
  drive_id   text primary key,
  full_jpg   bytea not null,
  thumb_jpg  bytea not null,
  width      int,
  height     int,
  staged_at  timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['families','people','items','photos','item_photos',
                           'rankings','item_edits','import_tokens','photo_staging']
  loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('revoke all on app.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on all sequences in schema app from public, anon, authenticated;

-- FORCE RLS also applies to the table owner, so give the owner (used by the
-- security-definer functions and the GitHub Actions) an explicit full policy.
do $$
declare t text;
begin
  foreach t in array array['families','people','items','photos','item_photos',
                           'rankings','item_edits','import_tokens','photo_staging']
  loop
    if not exists (select 1 from pg_policies
                   where schemaname = 'app' and tablename = t and policyname = 'owner_all') then
      execute format('create policy owner_all on app.%I for all to postgres using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- Bootstrap import token (only its SHA-256 hash is stored here).
insert into app.import_tokens (token_hash)
values (decode('894182f6531af4ede15d4639d52c72c469c9c218736e1e7b0924ab0fe47d76c7', 'hex'))
on conflict do nothing;

-- ---------------------------------------------------------------- results view

create or replace view app.item_results as
with fam as (
  select r.item_id, p.family_id, min(r.rank) as best
  from app.rankings r
  join app.people p on p.id = r.person_id
  where p.family_id is not null
  group by r.item_id, p.family_id
),
ov as (
  select item_id, min(best) as overall from fam group by item_id
)
select i.id as item_id,
       coalesce((select jsonb_object_agg(f.family_id::text, f.best)
                 from fam f where f.item_id = i.id), '{}'::jsonb) as family_best,
       ov.overall as overall_best,
       coalesce((select jsonb_agg(f.family_id order by f.family_id)
                 from fam f where f.item_id = i.id and f.best = ov.overall), '[]'::jsonb) as top_families
from app.items i
left join ov on ov.item_id = i.id;

revoke all on app.item_results from public, anon, authenticated;

-- ---------------------------------------------------------------- helpers

create or replace function app.key_hash(p_key text)
returns bytea language sql immutable set search_path = '' as $$
  select extensions.digest(convert_to(coalesce(p_key, ''), 'UTF8'), 'sha256')
$$;

create or replace function app.new_key()
returns text language sql volatile set search_path = '' as $$
  select translate(rtrim(encode(extensions.gen_random_bytes(24), 'base64'), '='), '+/', '-_')
$$;

create or replace function app.person_for(p_key text)
returns app.people language plpgsql stable security definer set search_path = '' as $$
declare v app.people;
begin
  if p_key is null or length(p_key) < 20 then
    raise exception 'invalid link' using errcode = '28000';
  end if;
  select * into v from app.people where link_key_hash = app.key_hash(p_key);
  if not found then
    raise exception 'invalid link' using errcode = '28000';
  end if;
  return v;
end $$;

create or replace function app.admin_for(p_key text)
returns app.people language plpgsql stable security definer set search_path = '' as $$
declare v app.people;
begin
  v := app.person_for(p_key);
  if not v.is_admin then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return v;
end $$;

create or replace function app.check_import_token(p_token text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.import_tokens
                 where token_hash = app.key_hash(p_token) and active) then
    raise exception 'invalid import token' using errcode = '28000';
  end if;
end $$;

-- ---------------------------------------------------------------- public API

-- Everything the site needs in one call.
create or replace function public.fi_load(p_key text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  me app.people;
  result jsonb;
begin
  me := app.person_for(p_key);
  update app.people set last_seen_at = now() where id = me.id;

  select jsonb_build_object(
    'me', jsonb_build_object('id', me.id, 'name', me.name, 'role', me.role,
                             'family_id', me.family_id, 'is_admin', me.is_admin),
    'families', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'name', f.name,
               'members', coalesce((
                 select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'role', p.role)
                                  order by p.sort, p.id)
                 from app.people p where p.family_id = f.id), '[]'::jsonb))
             order by f.sort, f.id)
      from app.families f), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'name', i.name, 'room', i.room, 'photo_no', i.photo_no,
               'type', i.type, 'subtype', i.subtype, 'origin', i.origin,
               'description', i.description, 'hidden', i.hidden,
               'photos', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'full', ph.full_url, 'thumb', ph.thumb_url,
                          'w', ph.width, 'h', ph.height,
                          'drive', 'https://drive.google.com/file/d/' || ph.original_drive_id || '/view')
                        order by ip.sort_order)
                 from app.item_photos ip join app.photos ph on ph.id = ip.photo_id
                 where ip.item_id = i.id), '[]'::jsonb),
               'ranks', coalesce((
                 select jsonb_object_agg(r.person_id::text, r.rank)
                 from app.rankings r where r.item_id = i.id), '{}'::jsonb),
               'family_best', res.family_best,
               'overall_best', res.overall_best,
               'top_families', res.top_families)
             order by i.sort, i.id)
      from app.items i
      join app.item_results res on res.item_id = i.id
      where me.is_admin or not i.hidden), '[]'::jsonb)
  ) into result;
  return result;
end $$;

-- Set (1..5) or clear (null) the caller's own rank on an item.
create or replace function public.fi_set_rank(p_key text, p_item text, p_rank int)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  me app.people;
  res jsonb;
begin
  me := app.person_for(p_key);
  if me.family_id is null then
    raise exception 'only family members can rank' using errcode = '42501';
  end if;
  if not exists (select 1 from app.items where id = p_item and not hidden) then
    raise exception 'unknown item' using errcode = 'P0002';
  end if;
  if p_rank is null then
    delete from app.rankings where person_id = me.id and item_id = p_item;
  elsif p_rank between 1 and 5 then
    insert into app.rankings (person_id, item_id, rank)
    values (me.id, p_item, p_rank)
    on conflict (person_id, item_id) do update set rank = excluded.rank, updated_at = now();
  else
    raise exception 'rank must be 1 to 5' using errcode = '22023';
  end if;

  select jsonb_build_object(
           'ranks', coalesce((select jsonb_object_agg(r.person_id::text, r.rank)
                              from app.rankings r where r.item_id = p_item), '{}'::jsonb),
           'family_best', res2.family_best,
           'overall_best', res2.overall_best,
           'top_families', res2.top_families)
    into res
  from app.item_results res2 where res2.item_id = p_item;
  return res;
end $$;

-- Edit a descriptive field; every change is recorded in app.item_edits.
create or replace function public.fi_edit_item(p_key text, p_item text, p_field text, p_value text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  me app.people;
  old_v text;
  new_v text := left(btrim(coalesce(p_value, '')), 4000);
begin
  me := app.person_for(p_key);
  if p_field not in ('name', 'type', 'subtype', 'origin', 'description') then
    raise exception 'field cannot be edited' using errcode = '22023';
  end if;
  if p_field = 'name' and new_v = '' then
    raise exception 'name cannot be empty' using errcode = '22023';
  end if;
  if not exists (select 1 from app.items where id = p_item) then
    raise exception 'unknown item' using errcode = 'P0002';
  end if;
  execute format('select %I from app.items where id = $1', p_field) into old_v using p_item;
  if old_v is distinct from new_v then
    execute format('update app.items set %I = $1, updated_by = $2, updated_at = now() where id = $3', p_field)
      using new_v, me.id, p_item;
    insert into app.item_edits (item_id, person_id, field, old_value, new_value)
    values (p_item, me.id, p_field, old_v, new_v);
  end if;
  return jsonb_build_object('field', p_field, 'value', new_v);
end $$;

create or replace function public.fi_item_history(p_key text, p_item text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.person_for(p_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', e.id, 'field', e.field, 'old', e.old_value, 'new', e.new_value,
             'at', e.at, 'by', coalesce(p.name, 'Import'))
           order by e.at desc, e.id desc)
    from app.item_edits e left join app.people p on p.id = e.person_id
    where e.item_id = p_item), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- admin API

create or replace function public.fi_admin_people(p_key text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.admin_for(p_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'name', p.name, 'role', p.role, 'is_admin', p.is_admin,
             'family_id', p.family_id, 'family', f.name,
             'has_link', p.link_key_hash is not null,
             'last_seen_at', p.last_seen_at,
             'ranked', (select count(*) from app.rankings r where r.person_id = p.id))
           order by f.sort nulls first, p.sort, p.id)
    from app.people p left join app.families f on f.id = p.family_id), '[]'::jsonb);
end $$;

-- Make a fresh link key for a person. The old link stops working at once.
-- The raw key is returned only here and never stored.
create or replace function public.fi_admin_new_link(p_key text, p_person int)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare
  me app.people;
  k text := app.new_key();
begin
  me := app.admin_for(p_key);
  update app.people set link_key_hash = app.key_hash(k) where id = p_person;
  if not found then
    raise exception 'unknown person' using errcode = 'P0002';
  end if;
  return k;
end $$;

create or replace function public.fi_admin_turn_off_link(p_key text, p_person int)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me app.people;
begin
  me := app.admin_for(p_key);
  if p_person = me.id then
    raise exception 'you cannot turn off your own link' using errcode = '22023';
  end if;
  update app.people set link_key_hash = null where id = p_person;
end $$;

create or replace function public.fi_admin_set_hidden(p_key text, p_item text, p_hidden boolean)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me app.people;
begin
  me := app.admin_for(p_key);
  update app.items set hidden = p_hidden, updated_by = me.id, updated_at = now() where id = p_item;
  insert into app.item_edits (item_id, person_id, field, old_value, new_value)
  values (p_item, me.id, 'hidden', (not p_hidden)::text, p_hidden::text);
end $$;

-- ---------------------------------------------------------------- keep-alive

create or replace function public.fi_ping()
returns int language sql stable set search_path = '' as $$ select 1 $$;

-- ---------------------------------------------------------------- one-time import

-- Loads families, people and items. Ranks are never imported.
create or replace function public.fi_import(p_token text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  f jsonb; p jsonb; it jsonb; d text; n int := 0; fid int; pid uuid; ord int;
begin
  perform app.check_import_token(p_token);

  for f in select * from jsonb_array_elements(coalesce(p_payload->'families', '[]')) loop
    insert into app.families (name, sort) values (f->>'name', (f->>'sort')::int)
    on conflict (name) do update set sort = excluded.sort;
  end loop;

  for p in select * from jsonb_array_elements(coalesce(p_payload->'people', '[]')) loop
    select id into fid from app.families where name = p->>'family';
    if exists (select 1 from app.people
               where name = p->>'name' and family_id is not distinct from fid) then
      update app.people
         set role = p->>'role', is_admin = coalesce((p->>'is_admin')::boolean, false),
             sort = coalesce((p->>'sort')::int, 0),
             link_key_hash = coalesce(decode(p->>'key_sha256', 'hex'), link_key_hash)
       where name = p->>'name' and family_id is not distinct from fid;
    else
      insert into app.people (family_id, name, role, is_admin, sort, link_key_hash)
      values (fid, p->>'name', p->>'role', coalesce((p->>'is_admin')::boolean, false),
              coalesce((p->>'sort')::int, 0), decode(p->>'key_sha256', 'hex'));
    end if;
  end loop;

  for it in select * from jsonb_array_elements(coalesce(p_payload->'items', '[]')) loop
    insert into app.items (id, name, room, photo_no, type, subtype, origin, description, sort)
    values (it->>'id', it->>'name', coalesce(it->>'room', ''), coalesce(it->>'photo_no', ''),
            coalesce(it->>'type', ''), coalesce(it->>'subtype', ''), coalesce(it->>'origin', ''),
            coalesce(it->>'description', ''), coalesce((it->>'sort')::int, 0))
    on conflict (id) do update
      set name = excluded.name, room = excluded.room, photo_no = excluded.photo_no,
          type = excluded.type, subtype = excluded.subtype, origin = excluded.origin,
          description = excluded.description, sort = excluded.sort;
    ord := 0;
    for d in select jsonb_array_elements_text(coalesce(it->'photos', '[]')) loop
      insert into app.photos (original_drive_id) values (d) on conflict (original_drive_id) do nothing;
      select id into pid from app.photos where original_drive_id = d;
      insert into app.item_photos (item_id, photo_id, sort_order) values (it->>'id', pid, ord)
      on conflict (item_id, photo_id) do update set sort_order = excluded.sort_order;
      ord := ord + 1;
    end loop;
    n := n + 1;
  end loop;

  return jsonb_build_object('items', n,
                            'people', (select count(*) from app.people),
                            'photos', (select count(*) from app.photos));
end $$;

-- Stages one resized photo (base64 JPEG) for the GitHub Action to move into
-- private storage.
create or replace function public.fi_stage_photo(p_token text, p_drive_id text,
                                                 p_full_b64 text, p_thumb_b64 text,
                                                 p_width int, p_height int)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.check_import_token(p_token);
  if not exists (select 1 from app.photos where original_drive_id = p_drive_id) then
    raise exception 'unknown photo' using errcode = 'P0002';
  end if;
  insert into app.photo_staging (drive_id, full_jpg, thumb_jpg, width, height)
  values (p_drive_id, decode(p_full_b64, 'base64'), decode(p_thumb_b64, 'base64'), p_width, p_height)
  on conflict (drive_id) do update
    set full_jpg = excluded.full_jpg, thumb_jpg = excluded.thumb_jpg,
        width = excluded.width, height = excluded.height, staged_at = now();
end $$;

create or replace function public.fi_import_status(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.check_import_token(p_token);
  return jsonb_build_object(
    'items', (select count(*) from app.items),
    'people', (select count(*) from app.people),
    'photos', (select count(*) from app.photos),
    'photos_stored', (select count(*) from app.photos where storage_path is not null),
    'staged', (select count(*) from app.photo_staging));
end $$;

-- Switches the import token off for good.
create or replace function public.fi_import_finish(p_token text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform app.check_import_token(p_token);
  update app.import_tokens set active = false where token_hash = app.key_hash(p_token);
end $$;

-- ---------------------------------------------------------------- grants

revoke all on all functions in schema app from public, anon, authenticated;

do $$
declare fn text;
begin
  for fn in
    select p.oid::regprocedure::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'fi\_%'
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to anon, authenticated', fn);
  end loop;
end $$;

notify pgrst, 'reload schema';
