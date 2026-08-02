-- current_setting('app.tenant_id', true) can return an empty string ('')
-- rather than NULL in some pooled-connection paths (e.g. after RESET or a
-- Transaction Pooler connection handoff between statements). The direct
-- ::uuid cast on '' throws invalid input syntax for type uuid instead of
-- denying access, which is the opposite of the documented fail-closed
-- intent. Wrapping in nullif(..., '') normalizes '' to NULL first, so the
-- comparison correctly evaluates to false (deny) instead of erroring.
alter policy tenant_self_read on tenants
    using (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter policy tenant_isolation_users on users
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter policy tenant_isolation_tiny_credentials on tiny_credentials
    using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
    with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- None of tenants/users/tiny_credentials currently has FORCE ROW LEVEL
-- SECURITY, only ENABLE. Without FORCE, the table-owner/migration role can
-- bypass RLS entirely, undermining the fail-closed isolation guarantee.
alter table tenants force row level security;
alter table users force row level security;
alter table tiny_credentials force row level security;

-- Raw `create table` migrations don't auto-grant the way Studio-created
-- tables do, so authenticated was fully blocked at the ACL layer regardless
-- of the RLS policies above. SELECT-only is the correct scope right now
-- because no frontend code exists yet (Phase 2 auth / Phase 4 dashboard
-- unbuilt) and the only write paths documented for these three tables today
-- (tenant signup, Tiny OAuth credential storage) already run as
-- service_role per the existing comment in 20260729003512_init_schema.sql -
-- INSERT/UPDATE grants belong to whichever future phase actually implements
-- a direct authenticated write.
grant select on tenants, users, tiny_credentials to authenticated;
