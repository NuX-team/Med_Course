create or replace function course_medications_guard() returns trigger
language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform assert_revision_is_draft(old.revision_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform assert_revision_is_draft(new.revision_id);
  end if;
  if tg_op = 'UPDATE' then
    if new.revision_id <> old.revision_id then
      raise exception 'medication % cannot move to another revision', old.id
        using errcode = 'restrict_violation';
    end if;
    if new.prn and exists (select 1 from schedule_rules where medication_id = new.id) then
      raise exception 'medication % has schedule rules and cannot become as-needed (PRN)', new.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return coalesce(new, old);
end
$$;

create or replace function forbid_modification() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed: the table is append-only', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

drop table course_summaries;
alter table care_relationships drop column history_shared_at;

-- An account already anonymised has no Telegram id to give back: the old rule cannot hold for it.
alter table users drop constraint users_telegram_user_id_chk;
alter table users add constraint users_telegram_user_id_chk
  check (telegram_user_id > 0) not valid;
drop sequence erased_users_seq;

drop table deletion_requests;
