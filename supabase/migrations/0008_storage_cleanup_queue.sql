-- Storage deletion is not part of the database transaction. Keep paths whose deletion failed
-- so the scheduled housekeeping job can retry them without relying on a member visiting a page.
create table storage_cleanup_queue (
  path text primary key,
  queued_at timestamptz not null default now()
);

alter table storage_cleanup_queue enable row level security;
grant all on table storage_cleanup_queue to service_role;
