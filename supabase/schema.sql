-- Between the Tiers: database schema for Supabase (PostgreSQL)
-- Run this file first in the Supabase SQL editor, then run seed.sql.
--
-- Design in one paragraph: the browser never talks to the database. It talks to one Vercel function, which
-- calls the stored procedures below with the service-role key. The procedures check the answer key, time every
-- answer with the database clock, enforce rate limits and write the results. Tables have row level security
-- switched on and no policies, so the public anon key can read nothing.

-- ---------------------------------------------------------------- tables

create table if not exists players (
  id          uuid primary key default gen_random_uuid(),
  handle      text not null,
  secret_hash text not null,                        -- sha256(pepper + the player's device secret)
  created_at  timestamptz not null default now(),
  constraint players_handle_format check (handle ~ '^[A-Za-z0-9 _.-]{2,16}$')
);
-- one handle per player, ignoring case
create unique index if not exists players_handle_ci_uq on players (lower(handle));

create table if not exists questions (
  id          smallint primary key,
  position    smallint not null unique,             -- order shown to the player
  tag         text not null,
  prompt      text not null,
  options     jsonb not null,                       -- exactly four answer strings
  correct_idx smallint not null check (correct_idx between 0 and 3),
  explanation text not null,
  slide       smallint not null,
  constraint questions_four_options check (jsonb_typeof(options) = 'array' and jsonb_array_length(options) = 4)
);

-- one row per quiz attempt
create table if not exists runs (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players(id) on delete cascade,
  ip_hash     text not null,                        -- sha256(pepper + ip), used only for rate limiting
  started_at  timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  score       integer check (score >= 0),
  correct     smallint check (correct >= 0),
  total_ms    integer check (total_ms >= 0),
  constraint runs_finished_is_complete check ((finished_at is null) = (score is null))
);
create index if not exists runs_ip_recent on runs (ip_hash, started_at desc);
create index if not exists runs_player_recent on runs (player_id, started_at desc);

-- one row per answered question; elapsed_ms is measured by the database clock, never by the browser
create table if not exists run_answers (
  run_id      uuid not null references runs(id) on delete cascade,
  question_id smallint not null references questions(id),
  choice      smallint not null check (choice between 0 and 3),
  is_correct  boolean not null,
  elapsed_ms  integer not null check (elapsed_ms >= 0),
  points      integer not null check (points >= 0),
  answered_at timestamptz not null default clock_timestamp(),
  primary key (run_id, question_id)
);

-- best run per player, kept up to date by a trigger
create table if not exists leaderboard (
  player_id  uuid primary key references players(id) on delete cascade,
  best_score integer not null,
  correct    smallint not null,
  total_ms   integer not null,
  attempts   integer not null default 1,
  updated_at timestamptz not null default now()
);
create index if not exists leaderboard_order on leaderboard (best_score desc, total_ms asc);

-- ---------------------------------------------------------------- trigger

create or replace function refresh_leaderboard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into leaderboard as l (player_id, best_score, correct, total_ms, attempts, updated_at)
  values (new.player_id, new.score, new.correct, new.total_ms, 1, now())
  on conflict (player_id) do update set
    attempts   = l.attempts + 1,
    updated_at = now(),
    best_score = case when excluded.best_score > l.best_score
                       or (excluded.best_score = l.best_score and excluded.total_ms < l.total_ms)
                      then excluded.best_score else l.best_score end,
    correct    = case when excluded.best_score > l.best_score
                       or (excluded.best_score = l.best_score and excluded.total_ms < l.total_ms)
                      then excluded.correct else l.correct end,
    total_ms   = case when excluded.best_score > l.best_score
                       or (excluded.best_score = l.best_score and excluded.total_ms < l.total_ms)
                      then excluded.total_ms else l.total_ms end;
  return null;
end $$;

drop trigger if exists runs_after_finish on runs;
create trigger runs_after_finish
  after update of finished_at on runs
  for each row
  when (old.finished_at is null and new.finished_at is not null)
  execute function refresh_leaderboard();

-- ---------------------------------------------------------------- stored procedures
-- Every procedure raises a short error code (for example handle_taken) that the Vercel function turns into an HTTP status.

-- 1. Claim or verify a callsign, rate limit, open a run and hand out the questions (without answers).
create or replace function start_run(p_handle text, p_secret_hash text, p_ip_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_player players%rowtype;
  v_run    uuid;
begin
  if p_handle is null or p_handle !~ '^[A-Za-z0-9 _.-]{2,16}$' or coalesce(p_secret_hash, '') = '' or coalesce(p_ip_hash, '') = '' then
    raise exception 'invalid_input';
  end if;
  if not exists (select 1 from questions) then raise exception 'not_seeded'; end if;

  -- no more than 20 runs per 10 minutes from one address
  if (select count(*) from runs where ip_hash = p_ip_hash and started_at > clock_timestamp() - interval '10 minutes') >= 20 then
    raise exception 'rate_limited';
  end if;

  select * into v_player from players where lower(handle) = lower(p_handle);
  if not found then
    begin
      insert into players (handle, secret_hash) values (p_handle, p_secret_hash) returning * into v_player;
    exception when unique_violation then
      raise exception 'handle_taken';
    end;
  elsif v_player.secret_hash <> p_secret_hash then
    raise exception 'handle_taken';
  end if;

  -- no more than 10 runs per 10 minutes for one player
  if (select count(*) from runs where player_id = v_player.id and started_at > clock_timestamp() - interval '10 minutes') >= 10 then
    raise exception 'rate_limited';
  end if;

  insert into runs (player_id, ip_hash) values (v_player.id, p_ip_hash) returning id into v_run;

  return jsonb_build_object(
    'run_id', v_run,
    'handle', v_player.handle,
    'questions', (select jsonb_agg(jsonb_build_object('id', id, 'tag', tag, 'prompt', prompt, 'options', options) order by position) from questions));
end $$;

-- 2. Grade one answer. The question must be the next unanswered one; the database clock decides the speed bonus.
create or replace function answer_question(p_run uuid, p_secret_hash text, p_question smallint, p_choice smallint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_run    runs%rowtype;
  v_q      questions%rowtype;
  v_done   integer;
  v_next   smallint;
  v_served timestamptz;
  v_ms     integer;
  v_ok     boolean;
  v_pts    integer;
begin
  if p_choice is null or p_choice not between 0 and 3 then raise exception 'invalid_input'; end if;

  select r.* into v_run
    from runs r join players p on p.id = r.player_id
   where r.id = p_run and p.secret_hash = p_secret_hash
   for update of r;
  if not found then raise exception 'forbidden'; end if;
  if v_run.finished_at is not null then raise exception 'already_finished'; end if;

  select count(*) into v_done from run_answers where run_id = p_run;
  select id into v_next from questions order by position limit 1 offset v_done;
  if v_next is null or v_next <> p_question then raise exception 'out_of_order'; end if;

  select * into v_q from questions where id = p_question;
  select coalesce(max(answered_at), v_run.started_at) into v_served from run_answers where run_id = p_run;

  v_ms  := greatest(0, round(extract(epoch from (clock_timestamp() - v_served)) * 1000))::integer;
  v_ok  := (p_choice = v_q.correct_idx);
  v_pts := case when v_ok then 100 + round(50 * greatest(0, 1 - v_ms / 30000.0))::integer else 0 end;

  begin
    insert into run_answers (run_id, question_id, choice, is_correct, elapsed_ms, points)
    values (p_run, p_question, p_choice, v_ok, v_ms, v_pts);
  exception when unique_violation then
    raise exception 'already_answered';
  end;

  return jsonb_build_object('correct', v_ok, 'correct_idx', v_q.correct_idx, 'explanation', v_q.explanation,
                            'slide', v_q.slide, 'points', v_pts, 'elapsed_ms', v_ms);
end $$;

-- 3. Close the run, total it up and (through the trigger) update the leaderboard.
create or replace function finish_run(p_run uuid, p_secret_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_run     runs%rowtype;
  v_score   integer;
  v_correct integer;
  v_ms      integer;
begin
  select r.* into v_run
    from runs r join players p on p.id = r.player_id
   where r.id = p_run and p.secret_hash = p_secret_hash
   for update of r;
  if not found then raise exception 'forbidden'; end if;
  if v_run.finished_at is not null then raise exception 'already_finished'; end if;
  if (select count(*) from run_answers where run_id = p_run) < (select count(*) from questions) then
    raise exception 'incomplete';
  end if;

  select sum(points), count(*) filter (where is_correct), sum(elapsed_ms)
    into v_score, v_correct, v_ms from run_answers where run_id = p_run;

  update runs set finished_at = clock_timestamp(), score = v_score, correct = v_correct, total_ms = v_ms where id = p_run;

  return jsonb_build_object('score', v_score, 'correct', v_correct, 'total_ms', v_ms);
end $$;

-- 4. Read the leaderboard. Equal scores and times share a place. is_me tells the caller which row is theirs.
create or replace function get_board(p_limit integer, p_secret_hash text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.place, t.handle), '[]'::jsonb)
  from (
    select rank() over (order by l.best_score desc, l.total_ms asc) as place,
           p.handle, l.best_score, l.correct, l.total_ms, l.attempts,
           (p.secret_hash = coalesce(p_secret_hash, '')) as is_me
      from leaderboard l join players p on p.id = l.player_id
     order by place, p.handle
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) t
$$;

-- ---------------------------------------------------------------- access control
-- Row level security on, no policies: the public anon and authenticated roles can read and write nothing.
-- Only the service-role key (held by the Vercel function) can call the procedures.

alter table players     enable row level security;
alter table questions   enable row level security;
alter table runs        enable row level security;
alter table run_answers enable row level security;
alter table leaderboard enable row level security;

revoke all on players, questions, runs, run_answers, leaderboard from anon, authenticated;

revoke execute on function refresh_leaderboard()                                    from public, anon, authenticated;
revoke execute on function start_run(text, text, text)                              from public, anon, authenticated;
revoke execute on function answer_question(uuid, text, smallint, smallint)          from public, anon, authenticated;
revoke execute on function finish_run(uuid, text)                                   from public, anon, authenticated;
revoke execute on function get_board(integer, text)                                 from public, anon, authenticated;

grant execute on function start_run(text, text, text)                               to service_role;
grant execute on function answer_question(uuid, text, smallint, smallint)           to service_role;
grant execute on function finish_run(uuid, text)                                    to service_role;
grant execute on function get_board(integer, text)                                  to service_role;
