SET ROLE authenticated;
RESET app.tenant_id;
SELECT * FROM users;
RESET ROLE;