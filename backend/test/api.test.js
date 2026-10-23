'use strict';
/* api.test.js – end-to-end tests of the API against a real HTTP server and a real database.
   Run with:  npm test

   The order matters only in that `setup` creates the accounts the later tests sign in with.
   Role coverage: Superuser first (the most restrictive writing role), then Admin, Super admin
   and Viewer. */

process.env.DB_FILE = ':memory:';
process.env.SERVE_STATIC = '0';
process.env.LOG_REQUESTS = '0';
process.env.NODE_ENV = 'test';
process.env.SEED_TEST_ADMIN = '0';
process.env.SEED_SUPERADMIN_EMAIL = 'boss@tracker.com';
process.env.SEED_SUPERADMIN_PASSWORD = 'Boss@1234';
process.env.LOGIN_MAX_ATTEMPTS = '5';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/presenter/app');
const store = require('../src/model/store');

let server, base;

test.before(async () => {
  server = await createApp({ initDb: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await store.close();
});

/* ---------- tiny client ---------- */
async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json, headers: res.headers };
}

async function login(email, password) {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  assert.equal(res.status, 200, `sign-in failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

const tokens = {};

/* =====================================================================
   Setup: the seeded super admin creates one account per role
   ===================================================================== */
test('health reports the service before anyone signs in', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.setupRequired, false, 'the seeded super admin should already exist');
  assert.deepEqual(res.body.roles, ['superadmin', 'admin', 'superuser', 'viewer']);
});

test('setup: super admin signs in and creates an account for every role', async () => {
  tokens.superadmin = await login('boss@tracker.com', 'Boss@1234');

  const accounts = [
    { email: 'amina@example.com', name: 'Amina', role: 'admin', password: 'adminpw' },
    { email: 'sohel@example.com', name: 'Sohel', role: 'superuser', password: 'superpw' },
    { email: 'vik@example.com', name: 'Vik', role: 'viewer', password: 'viewerpw' },
  ];
  for (const account of accounts) {
    const res = await call('POST', '/api/users', { token: tokens.superadmin, body: account });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.role, account.role);
    assert.ok(!('password' in res.body), 'the password hash must never be returned');
  }

  tokens.admin = await login('amina@example.com', 'adminpw');
  tokens.superuser = await login('sohel@example.com', 'superpw');
  tokens.viewer = await login('vik@example.com', 'viewerpw');
});

/* =====================================================================
   SUPERUSER – view everything, write Tasks only, may export
   ===================================================================== */
test('superuser: signs in and is told its own permissions', async () => {
  const res = await call('GET', '/api/auth/me', { token: tokens.superuser });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'superuser');
  assert.deepEqual(res.body.permissions.writableTypes, ['Task']);
  assert.equal(res.body.permissions.export, true);
  assert.equal(res.body.permissions.manageUsers, false);
});

test('superuser: can create, edit, change the status of and delete a Task', async () => {
  const created = await call('POST', '/api/items', {
    token: tokens.superuser,
    body: { type: 'Task', title: 'Replace UPS battery', f1: 'Sohel', pri: 'High', e: '2026-10-20' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.id, /^T-\d+$/);
  assert.equal(created.body.s, 'Ongoing');
  assert.equal(created.body.createdBy, 'sohel@example.com');
  assert.equal(created.body.role, 'superuser', 'the role it was created with is recorded');

  const edited = await call('PATCH', `/api/items/${created.body.id}`, {
    token: tokens.superuser, body: { role: 'superadmin', title: 'Replace UPS battery – HO', ms: 'Quote - Done\nFit - Ongoing' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.title, 'Replace UPS battery – HO');
  assert.equal(edited.body.role, 'superuser', 'a role cannot be claimed by sending one');

  const status = await call('PATCH', `/api/items/${created.body.id}`, {
    token: tokens.superuser, body: { s: 'On Hold' },
  });
  assert.equal(status.status, 200);
  assert.equal(status.body.s, 'On Hold');

  const removed = await call('DELETE', `/api/items/${created.body.id}`, { token: tokens.superuser });
  assert.equal(removed.status, 200);
  assert.equal((await call('GET', `/api/items/${created.body.id}`, { token: tokens.superuser })).status, 404);
});

test('superuser: cannot create a Project or a Recurring item', async () => {
  for (const type of ['Project', 'Drive']) {
    const res = await call('POST', '/api/items', {
      token: tokens.superuser, body: { type, title: 'Should be refused', f1: 'Sohel' },
    });
    assert.equal(res.status, 403, `${type} should be refused`);
    assert.equal(res.body.error.code, 'forbidden');
    assert.match(res.body.error.message, /Superuser/);
  }
});

test('superuser: cannot edit or delete a Project even by claiming it is a Task', async () => {
  const project = await call('POST', '/api/items', {
    token: tokens.admin, body: { type: 'Project', title: 'Core banking DR site', f1: 'Amina' },
  });
  assert.equal(project.status, 201);
  const id = project.body.id;

  /* Sending type:'Task' must not change the check – the stored type decides. */
  const patch = await call('PATCH', `/api/items/${id}`, {
    token: tokens.superuser, body: { type: 'Task', title: 'hijacked' },
  });
  assert.equal(patch.status, 403);

  const put = await call('PUT', `/api/items/${id}`, {
    token: tokens.superuser, body: { type: 'Task', title: 'hijacked', f1: 'Sohel' },
  });
  assert.equal(put.status, 403);

  const del = await call('DELETE', `/api/items/${id}`, { token: tokens.superuser });
  assert.equal(del.status, 403);

  const still = await call('GET', `/api/items/${id}`, { token: tokens.superuser });
  assert.equal(still.body.title, 'Core banking DR site', 'the project must be untouched');
});

test('superuser: can read every item and the dashboard figures', async () => {
  const list = await call('GET', '/api/items', { token: tokens.superuser });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some(i => i.type === 'Project'), 'projects are visible to a superuser');

  const stats = await call('GET', '/api/stats', { token: tokens.superuser });
  assert.equal(stats.status, 200);
  assert.equal(typeof stats.body.total, 'number');
  assert.ok(stats.body.byType.Project);
});

test('superuser: can export as JSON and CSV', async () => {
  const json = await call('GET', '/api/export?format=json', { token: tokens.superuser });
  assert.equal(json.status, 200);
  assert.ok(Array.isArray(json.body.rows));

  const csv = await call('GET', '/api/export?format=csv', { token: tokens.superuser, raw: true });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.ok(text.includes('ID,Type,Title,Status'), 'the CSV carries a header row');
});

test('superuser: cannot manage users or read the audit log', async () => {
  assert.equal((await call('GET', '/api/users', { token: tokens.superuser })).status, 403);
  assert.equal((await call('POST', '/api/users', {
    token: tokens.superuser, body: { email: 'x@y.com', name: 'X', role: 'admin', password: 'pw12' },
  })).status, 403);
  assert.equal((await call('GET', '/api/audit', { token: tokens.superuser })).status, 403);
});

/* =====================================================================
   ADMIN – everything except user management
   ===================================================================== */
test('admin: can create every type of item and delete them', async () => {
  const made = [];
  for (const [type, title] of [['Project', 'Branch Wi-Fi rollout'], ['Drive', 'Monthly backup test'], ['Task', 'Renew SSL']]) {
    const res = await call('POST', '/api/items', { token: tokens.admin, body: { type, title, f1: 'Amina' } });
    assert.equal(res.status, 201, `${type}: ${JSON.stringify(res.body)}`);
    made.push(res.body.id);
  }
  assert.match(made[0], /^P-\d+$/);
  assert.match(made[1], /^D-\d+$/);
  assert.match(made[2], /^T-\d+$/);

  const del = await call('DELETE', `/api/items/${made[2]}`, { token: tokens.admin });
  assert.equal(del.status, 200);
});

test('admin: may export but may not manage users', async () => {
  assert.equal((await call('GET', '/api/export', { token: tokens.admin })).status, 200);
  assert.equal((await call('GET', '/api/users', { token: tokens.admin })).status, 403);
  assert.equal((await call('DELETE', '/api/users/vik@example.com', { token: tokens.admin })).status, 403);
});

/* =====================================================================
   VIEWER – read only
   ===================================================================== */
test('viewer: can read items and stats', async () => {
  const list = await call('GET', '/api/items', { token: tokens.viewer });
  assert.equal(list.status, 200);
  assert.ok(list.body.items.length > 0);
  assert.equal((await call('GET', '/api/stats', { token: tokens.viewer })).status, 200);
});

test('viewer: cannot write anything, cannot export, cannot manage users', async () => {
  for (const type of ['Project', 'Drive', 'Task']) {
    const res = await call('POST', '/api/items', { token: tokens.viewer, body: { type, title: 'No', f1: 'Vik' } });
    assert.equal(res.status, 403, `${type} must be refused for a viewer`);
    assert.match(res.body.error.message, /Viewer/);
  }
  const anyItem = (await call('GET', '/api/items', { token: tokens.viewer })).body.items[0];
  assert.equal((await call('PATCH', `/api/items/${anyItem.id}`, { token: tokens.viewer, body: { s: 'Done' } })).status, 403);
  assert.equal((await call('DELETE', `/api/items/${anyItem.id}`, { token: tokens.viewer })).status, 403);

  const exp = await call('GET', '/api/export', { token: tokens.viewer });
  assert.equal(exp.status, 403);
  assert.match(exp.body.error.message, /download or print/);

  assert.equal((await call('GET', '/api/users', { token: tokens.viewer })).status, 403);
});

/* =====================================================================
   SUPER ADMIN – user and role management
   ===================================================================== */
test('super admin: lists users without ever exposing a password hash', async () => {
  const res = await call('GET', '/api/users', { token: tokens.superadmin });
  assert.equal(res.status, 200);
  assert.equal(res.body.users.length, 4);
  for (const u of res.body.users) {
    assert.ok(!('password' in u), `${u.email} leaked its password field`);
  }
});

test('super admin: changing a role takes effect at once and ends the old session', async () => {
  const before = await call('GET', '/api/auth/me', { token: tokens.viewer });
  assert.equal(before.body.user.role, 'viewer');

  const changed = await call('PATCH', '/api/users/vik@example.com', {
    token: tokens.superadmin, body: { role: 'admin' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.role, 'admin');

  /* The viewer's old token is now dead, so stale rights cannot linger. */
  const after = await call('GET', '/api/auth/me', { token: tokens.viewer });
  assert.equal(after.body.user, null);

  /* Signing in again gives the new role and the new abilities. */
  const fresh = await login('vik@example.com', 'viewerpw');
  const nowAdmin = await call('POST', '/api/items', {
    token: fresh, body: { type: 'Project', title: 'Vik is an admin now', f1: 'Vik' },
  });
  assert.equal(nowAdmin.status, 201);
  await call('DELETE', `/api/items/${nowAdmin.body.id}`, { token: fresh });

  /* Put the account back so later assertions are not surprised. */
  await call('PATCH', '/api/users/vik@example.com', { token: tokens.superadmin, body: { role: 'viewer' } });
  tokens.viewer = await login('vik@example.com', 'viewerpw');
});

test('super admin: can reset a password and the new one works', async () => {
  const res = await call('PATCH', '/api/users/sohel@example.com', {
    token: tokens.superadmin, body: { password: 'brandnew' },
  });
  assert.equal(res.status, 200);
  const failed = await call('POST', '/api/auth/login', { body: { email: 'sohel@example.com', password: 'superpw' } });
  assert.equal(failed.status, 401);
  tokens.superuser = await login('sohel@example.com', 'brandnew');
});

test('super admin: protected from locking everyone out', async () => {
  const demote = await call('PATCH', '/api/users/boss@tracker.com', {
    token: tokens.superadmin, body: { role: 'viewer' },
  });
  assert.equal(demote.status, 400);
  assert.equal(demote.body.error.code, 'self_role');

  const remove = await call('DELETE', '/api/users/boss@tracker.com', { token: tokens.superadmin });
  assert.equal(remove.status, 400);
  assert.equal(remove.body.error.code, 'self_delete');
});

test('super admin: cannot create two accounts with the same email', async () => {
  const again = await call('POST', '/api/users', {
    token: tokens.superadmin, body: { email: 'Amina@Example.com', name: 'Copy', role: 'viewer', password: 'pw1234' },
  });
  assert.equal(again.status, 409);
});

test('super admin: reads the audit log and finds the earlier changes', async () => {
  const res = await call('GET', '/api/audit?limit=500', { token: tokens.superadmin });
  assert.equal(res.status, 200);
  const actions = res.body.entries.map(e => e.action);
  for (const expected of ['login', 'item.create', 'item.delete', 'user.create', 'user.update', 'export']) {
    assert.ok(actions.includes(expected), `the audit log should record "${expected}"`);
  }
});

/* =====================================================================
   Access requests – someone with no account asks to be let in
   ===================================================================== */
test('access requests: anyone may ask, only the super admin may approve', async () => {
  const asked = await call('POST', '/api/requests', {
    body: { id: 'visitor-1', email: 'new.person@example.com', name: 'New Person' },
  });
  assert.equal(asked.status, 201);

  assert.equal((await call('GET', '/api/requests', { token: tokens.viewer })).status, 403);

  const pending = await call('GET', '/api/requests', { token: tokens.superadmin });
  assert.equal(pending.body.requests.length, 1);

  const approved = await call('POST', '/api/users', {
    token: tokens.superadmin,
    body: { email: 'new.person@example.com', name: 'New Person', role: 'superuser', password: 'welcome1', requestId: 'visitor-1' },
  });
  assert.equal(approved.status, 201);
  assert.equal((await call('GET', '/api/requests', { token: tokens.superadmin })).body.requests.length, 0);

  const token = await login('new.person@example.com', 'welcome1');
  assert.equal((await call('POST', '/api/items', { token, body: { type: 'Task', title: 'First task', f1: 'New Person' } })).status, 201);
});

/* =====================================================================
   Authentication, validation and protection
   ===================================================================== */
test('signed-out callers get 401 on everything that needs an account', async () => {
  for (const [method, path] of [['GET', '/api/items'], ['GET', '/api/stats'], ['GET', '/api/export'], ['GET', '/api/users']]) {
    const res = await call(method, path);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  const create = await call('POST', '/api/items', { body: { type: 'Task', title: 'x', f1: 'y' } });
  assert.equal(create.status, 401);
});

test('a bad token is rejected rather than trusted', async () => {
  const res = await call('GET', '/api/items', { token: 'not-a-real-token' });
  assert.equal(res.status, 401);
});

test('signing out makes the token stop working', async () => {
  const token = await login('vik@example.com', 'viewerpw');
  assert.equal((await call('GET', '/api/auth/me', { token })).body.user.email, 'vik@example.com');
  assert.equal((await call('POST', '/api/auth/logout', { token })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token })).body.user, null);
});

test('input is validated, not trusted', async () => {
  const cases = [
    [{ type: 'Nonsense', title: 'x', f1: 'y' }, 'bad_type'],
    [{ type: 'Task', title: '', f1: 'y' }, 'bad_title'],
    [{ type: 'Task', title: 'x', f1: '' }, 'bad_focal'],
    [{ type: 'Task', title: 'x', f1: 'y', s: 'Flying' }, 'bad_status'],
    [{ type: 'Task', title: 'x', f1: 'y', pri: 'Urgent' }, 'bad_priority'],
    [{ type: 'Task', title: 'x', f1: 'y', sd: '14-10-2026' }, 'bad_date'],
  ];
  for (const [body, code] of cases) {
    const res = await call('POST', '/api/items', { token: tokens.admin, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, code, JSON.stringify(body));
  }

  const badUser = await call('POST', '/api/users', {
    token: tokens.superadmin, body: { email: 'not-an-email', name: 'X', role: 'admin', password: 'pw12' },
  });
  assert.equal(badUser.body.error.code, 'bad_email');

  const badRole = await call('POST', '/api/users', {
    token: tokens.superadmin, body: { email: 'ok@example.com', name: 'X', role: 'wizard', password: 'pw12' },
  });
  assert.equal(badRole.body.error.code, 'bad_role');

  const shortPw = await call('POST', '/api/users', {
    token: tokens.superadmin, body: { email: 'ok2@example.com', name: 'X', role: 'admin', password: 'a' },
  });
  assert.equal(shortPw.body.error.code, 'bad_password');
});

test('changing your own password needs the current one and then works', async () => {
  const token = await login('amina@example.com', 'adminpw');
  const wrong = await call('POST', '/api/auth/password', {
    token, body: { currentPassword: 'nope', newPassword: 'adminpw2' },
  });
  assert.equal(wrong.status, 400, 'a mistyped password must not look like an expired session');
  assert.equal(wrong.body.error.code, 'bad_current');
  assert.equal((await call('GET', '/api/auth/me', { token })).body.user.email, 'amina@example.com');

  const ok = await call('POST', '/api/auth/password', {
    token, body: { currentPassword: 'adminpw', newPassword: 'adminpw2' },
  });
  assert.equal(ok.status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'amina@example.com', password: 'adminpw' } })).status, 401);
  tokens.admin = await login('amina@example.com', 'adminpw2');
});

test('cookie sign-in works and is protected by a CSRF token', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'vik@example.com', password: 'viewerpw' }),
  });
  assert.equal(res.status, 200);
  const payload = await res.json();
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map(c => c.split(';')[0]).join('; ');
  assert.match(cookies, /tracker_session=/);
  assert.match(cookies, /tracker_csrf=/);

  /* Reading with the cookie alone is fine. */
  const read = await fetch(base + '/api/auth/me', { headers: { Cookie: cookies } });
  assert.equal((await read.json()).user.email, 'vik@example.com');

  /* A change with the cookie but no CSRF header is refused – this is what stops another site
     from acting on a signed-in person's behalf. */
  const noCsrf = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookies } });
  assert.equal(noCsrf.status, 403);

  /* With the header it goes through. */
  const withCsrf = await fetch(base + '/api/auth/logout', {
    method: 'POST', headers: { Cookie: cookies, 'X-CSRF-Token': payload.csrf },
  });
  assert.equal(withCsrf.status, 200);
});

test('repeated wrong passwords are throttled', async () => {
  let blocked = false;
  for (let i = 0; i < 10; i++) {
    const res = await call('POST', '/api/auth/login', { body: { email: 'throttle@example.com', password: 'wrong' } });
    if (res.status === 429) { blocked = true; break; }
    assert.equal(res.status, 401);
  }
  assert.ok(blocked, 'the server should start refusing after several failed attempts');
});

test('unknown endpoints and wrong methods answer clearly', async () => {
  assert.equal((await call('GET', '/api/nothing-here', { token: tokens.admin })).status, 404);
  const wrong = await call('DELETE', '/api/stats', { token: tokens.admin });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'GET');
});

test('item ids keep counting up and never collide', async () => {
  const a = await call('POST', '/api/items', { token: tokens.admin, body: { type: 'Task', title: 'One', f1: 'A' } });
  const b = await call('POST', '/api/items', { token: tokens.admin, body: { type: 'Task', title: 'Two', f1: 'A' } });
  assert.notEqual(a.body.id, b.body.id);
  const numA = Number(a.body.id.slice(2));
  const numB = Number(b.body.id.slice(2));
  assert.equal(numB, numA + 1);
});

test('changing your own password keeps this device signed in and drops the others', async () => {
  const here = await login('vik@example.com', 'viewerpw');
  const elsewhere = await login('vik@example.com', 'viewerpw');

  const res = await call('POST', '/api/auth/password', {
    token: here, body: { currentPassword: 'viewerpw', newPassword: 'nextone1' },
  });
  assert.equal(res.status, 200);

  assert.equal((await call('GET', '/api/auth/me', { token: here })).body.user.email, 'vik@example.com');
  assert.equal((await call('GET', '/api/auth/me', { token: elsewhere })).body.user, null);

  /* put it back so later tests still know the password */
  await call('POST', '/api/auth/password', { token: here, body: { currentPassword: 'nextone1', newPassword: 'viewerpw' } });
});

/* ---------------------------------------------------------------- the team roster */
/* Earlier tests revoke and reassign the role tokens, so the roster tests sign in people of
   their own rather than reuse a token something else has already ended. */
async function freshToken(role, email, password) {
  await call('POST', '/api/users', { token: tokens.superadmin, body: { email, name: 'Roster ' + role, role, password } });
  return (await call('POST', '/api/auth/login', { body: { email, password } })).body.token;
}

test('team: the super admin adds, edits and removes members; everyone may read the roster', async () => {
  const viewer = await freshToken('viewer', 'roster-viewer@example.com', 'viewerpw');
  const added = await call('POST', '/api/team', { token: tokens.superadmin, body: { name: 'Mosiar Rahman', title: 'Senior Officer, IS', email: 'Mosiar@brac.net' } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.id, 'm_mosiar_rahman');
  assert.equal(added.body.email, 'mosiar@brac.net');

  const seen = await call('GET', '/api/team', { token: viewer });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.members.length, 1, 'a viewer can read the roster');

  const edited = await call('POST', '/api/team', { token: tokens.superadmin, body: { id: added.body.id, name: 'Mosiar Rahman', title: 'Lead, IS' } });
  assert.equal(edited.body.title, 'Lead, IS');
  assert.equal((await call('GET', '/api/team', { token: viewer })).body.members.length, 1, 'an edit adds no row');

  const gone = await call('DELETE', `/api/team/${added.body.id}`, { token: tokens.superadmin });
  assert.equal(gone.status, 200);
  assert.equal((await call('GET', '/api/team', { token: viewer })).body.members.length, 0);
});

test('team: nobody but the super admin may change the roster', async () => {
  const others = {
    admin: await freshToken('admin', 'roster-admin@example.com', 'adminpw'),
    superuser: await freshToken('superuser', 'roster-super@example.com', 'superpw'),
    viewer: await freshToken('viewer', 'roster-viewer2@example.com', 'viewerpw'),
  };
  for (const who of Object.keys(others)) {
    assert.equal((await call('POST', '/api/team', { token: others[who], body: { name: 'Intruder' } })).status, 403, who);
    assert.equal((await call('DELETE', '/api/team/m_x', { token: others[who] })).status, 403, who);
    assert.equal((await call('POST', '/api/team/rename', { token: others[who], body: { from: 'A', to: 'B' } })).status, 403, who);
  }
  assert.equal((await call('POST', '/api/team', { token: tokens.superadmin, body: { name: '  ' } })).status, 400);
});

test('team: renaming a person renames them on every item they are on, and nowhere else', async () => {
  const mk = (type, title, f1, f2) => call('POST', '/api/items', { token: tokens.admin, body: { type, title, f1, f2 } });
  const a = await mk('Project', 'Core banking', 'Mosiar', 'Sarwar');
  const b = await mk('Task', 'UPS battery', 'Sarwar', 'Mosiar');
  const c = await mk('Task', 'SSL renewal', 'Azmir', '');
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(c.status, 201);

  const done = await call('POST', '/api/team/rename', { token: tokens.superadmin, body: { from: 'mosiar', to: 'Md. Mosiar Rahman' } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.count, 2);

  const get = async id => (await call('GET', `/api/items/${id}`, { token: tokens.admin })).body;
  assert.equal((await get(a.body.id)).f1, 'Md. Mosiar Rahman');
  assert.equal((await get(a.body.id)).f2, 'Sarwar');
  assert.equal((await get(b.body.id)).f2, 'Md. Mosiar Rahman');
  assert.equal((await get(c.body.id)).f1, 'Azmir');
});
