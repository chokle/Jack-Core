-- Historical migration fetched from the verified production migration ledger.
create or replace function private.sync_command_centre_demo_statuses()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.key <> 'operational_state' then
    return new;
  end if;

  update public.demo_requests as request
  set lead_status = lead.value ->> 'status',
      updated_at = now()
  from jsonb_array_elements(
    case
      when jsonb_typeof(new.value -> 'leads') = 'array' then new.value -> 'leads'
      else '[]'::jsonb
    end
  ) as lead(value)
  where lead.value ->> 'inboundType' = 'demo_request'
    and lead.value ->> 'demoRequestId' = request.id::text
    and lead.value ->> 'status' in (
      'New',
      'Contacted',
      'Demo scheduled',
      'Demo completed',
      'Pilot discussion',
      'Pilot proposed',
      'Closed',
      'Not currently qualified'
    )
    and request.lead_status is distinct from lead.value ->> 'status';

  return new;
end;
$function$;

drop trigger if exists command_centre_sync_demo_statuses on public.command_centre_state;
create trigger command_centre_sync_demo_statuses
after update of value on public.command_centre_state
for each row execute function private.sync_command_centre_demo_statuses();
