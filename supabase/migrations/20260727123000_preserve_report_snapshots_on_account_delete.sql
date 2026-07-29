alter table public.activity_report_runs
  alter column requested_by_user_id drop not null;

comment on column public.activity_report_runs.requested_by_user_id is
  'Requester attribution for the generated report snapshot. Nullable so self-service account deletion can preserve shared pilot aggregates while removing personal attribution.';
