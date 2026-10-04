drop index dose_events_prn_idx;

-- The older rules know no "taken back" marks: those rows go, which the append-only log allows
-- only with its guard lifted for the length of this statement.
alter table dose_events disable trigger dose_events_append_only;
delete from dose_events where event_type = 'PRN_CANCELLED';
alter table dose_events enable trigger dose_events_append_only;

alter table dose_events drop constraint dose_events_prn_line_chk;
alter table dose_events
  add constraint dose_events_prn_line_chk
    check (event_type <> 'PRN_TAKEN' or medication_line_id is not null);
alter table dose_events drop constraint dose_events_prn_chk;
alter table dose_events
  add constraint dose_events_prn_chk check ((event_type = 'PRN_TAKEN') = (scheduled_dose_id is null));
alter table dose_events drop constraint dose_events_event_type_chk;
alter table dose_events
  add constraint dose_events_event_type_chk check (event_type in (
    'NOTIFIED', 'SNOOZED', 'TAKEN', 'SKIPPED', 'MISSED', 'LATE_TAKEN', 'CORRECTION', 'SUPERSEDED', 'PRN_TAKEN'
  ));

drop table doctor_alerts;
