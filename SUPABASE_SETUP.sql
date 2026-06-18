-- ── LiftLog · Supabase schema ────────────────────────────────────────────────
-- Run this once in your Supabase project's SQL editor (Dashboard → SQL Editor →
-- New query → paste → Run). It creates one table per data store, each scoped to
-- the signed-in user via Row-Level Security. Safe to re-run (idempotent).
--
-- Model: (user_id, id) primary key; the record itself lives in `data` (jsonb);
-- `updated_at` drives last-write-wins; `deleted` marks tombstones.

do $$
declare t text;
begin
  foreach t in array array['exercises','workouts','sets','templates','settings']
  loop
    execute format($f$
      create table if not exists public.%I (
        user_id    uuid        not null references auth.users(id) on delete cascade,
        id         text        not null,
        data       jsonb       not null default '{}'::jsonb,
        updated_at timestamptz not null default now(),
        deleted    boolean     not null default false,
        primary key (user_id, id)
      );
    $f$, t);

    execute format('alter table public.%I enable row level security;', t);

    -- One policy: a user can do anything to their own rows, nothing to others'.
    execute format('drop policy if exists own_rows on public.%I;', t);
    execute format($p$
      create policy own_rows on public.%I
        for all
        using (user_id = auth.uid())
        with check (user_id = auth.uid());
    $p$, t);

    -- Helps the (future) incremental pull-by-cursor.
    execute format('create index if not exists %I on public.%I (user_id, updated_at);',
      t || '_uid_updated_idx', t);
  end loop;
end $$;
