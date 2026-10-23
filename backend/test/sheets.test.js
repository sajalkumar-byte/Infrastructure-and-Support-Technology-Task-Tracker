'use strict';
/* sheets.test.js – the whole server running on Google Sheets storage.

   Every table lives in a spreadsheet tab, reached over the real Sheets REST API shape and a
   real signed service-account token. The Google side is a local stand-in (test/fake-google.js),
   so nothing is sent to Google, but the driver's code path is the same one production uses.

   This is the proof that "all the data is saved in the sheet, role-wise" actually holds. */

process.env.SERVE_STATIC = '0';
process.env.LOG_REQUESTS = '0';
process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'memory';
process.env.SEED_TEST_ADMIN = '0';
process.env.SEED_SUPERADMIN_EMAIL = 'boss@tracker.com';
process.env.SEED_SUPERADMIN_PASSWORD = 'Boss@1234';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const store = require('../src/model/store');
const mailer = require('../src/view/mailer');
const { createFakeGoogle, makeServiceAccount } = require('./fake-google');

let google, server, base;
const tokens = {};

test.before(async () => {
  const account = makeServiceAccount();
  google = createFakeGoogle({ spreadsheetId: 'test-sheet', publicKey: account.publicKey });
  const port = await google.listen();

  /* Point the server at the stand-in and switch the storage over. */
  config.storage = 'sheets';
  config.sheets.spreadsheetId = 'test-sheet';
  config.sheets.credentials = JSON.stringify(account.credentials);
  config.sheets.apiBase = `http://127.0.0.1:${port}`;
  config.sheets.tokenUrl = `http://127.0.0.1:${port}/token`;
  config.sheets.cacheMs = 0;                 // never serve a stale read inside a test

  const { createApp } = require('../src/presenter/app');
  server = await createApp({ initDb: true });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(r => server.close(r));
  await store.close();
  await google.close();
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

/* ===================================================================== */
test('the spreadsheet gets a tab per table, each with a header row', () => {
  const titles = [...google.tabs.keys()].sort();
  assert.deepEqual(titles, ['Archive', 'Audit', 'Items', 'Messages', 'Meta', 'Requests', 'Resets', 'Sessions', 'Team', 'Users']);

  const header = google.tabs.get('Items').rows[0];
  assert.deepEqual(header.slice(0, 6), ['id', 'type', 'title', 's', 'pri', 'f1']);
});

test('the seeded super admin is a row in the Users tab, with a hashed password', async () => {
  const rows = google.rowsOf('Users');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'boss@tracker.com');
  assert.equal(rows[0].role, 'superadmin');
  /* On a spreadsheet the hash is written in the format the Apps Script backend can also read,
     because both of them serve the same Users tab. scrypt is used everywhere else. */
  assert.match(rows[0].password, /^sha256\$500\$/);
  assert.ok(!rows[0].password.includes('Boss@1234'), 'the typed password is never written down');

  tokens.superadmin = await login('boss@tracker.com', 'Boss@1234');
});

test('signing in writes a session row, signing out removes it', async () => {
  assert.equal(google.rowsOf('Sessions').length, 1, 'one sign-in, one row');
  const row = google.rowsOf('Sessions')[0];
  assert.equal(row.email, 'boss@tracker.com');
  assert.equal(row.tokenHash.length, 64, 'only the hash of the token is stored');
  assert.ok(!row.tokenHash.includes(tokens.superadmin), 'never the token itself');

  const temp = await login('boss@tracker.com', 'Boss@1234');
  assert.equal(google.rowsOf('Sessions').length, 2);
  await call('POST', '/api/auth/logout', { token: temp });
  assert.equal(google.rowsOf('Sessions').length, 1, 'the row goes when the person signs out');
});

test('the super admin creates one account per role, each as a sheet row', async () => {
  const accounts = [
    { email: 'amina@example.com', name: 'Amina', role: 'admin', password: 'adminpw' },
    { email: 'sohel@example.com', name: 'Sohel', role: 'superuser', password: 'superpw' },
    { email: 'vik@example.com', name: 'Vik', role: 'viewer', password: 'viewerpw' },
  ];
  for (const account of accounts) {
    const res = await call('POST', '/api/users', { token: tokens.superadmin, body: account });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const rows = google.rowsOf('Users');
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map(r => `${r.email}=${r.role}`).sort(),
    ['amina@example.com=admin', 'boss@tracker.com=superadmin', 'sohel@example.com=superuser', 'vik@example.com=viewer']
  );

  tokens.admin = await login('amina@example.com', 'adminpw');
  tokens.superuser = await login('sohel@example.com', 'superpw');
  tokens.viewer = await login('vik@example.com', 'viewerpw');
});

test('an account created here can also sign in through the Apps Script backend', async () => {
  /* The same spreadsheet is served by both, so a row written by one has to be usable by the
     other. This runs the genuine Code.gs against the row this server actually wrote. */
  const { load } = require(require('node:path')
    .resolve(__dirname, '../../google-apps-script/test/harness.js'));
  const { sandbox } = load();

  const row = google.rowsOf('Users').find(r => r.email === 'amina@example.com');
  assert.ok(row, 'the account should be in the Users tab');
  assert.equal(sandbox.verifyPassword_('adminpw', row.password), true);
  assert.equal(sandbox.verifyPassword_('not the password', row.password), false);
});

/* ---------------------------------------------------------------- items in the sheet */
test('an item created through the API appears as a row in the Items tab', async () => {
  const res = await call('POST', '/api/items', {
    token: tokens.admin,
    body: { type: 'Project', title: 'Core banking DR site', f1: 'Amina', pri: 'High', sd: '2026-07-01', e: '2026-12-31' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  const rows = google.rowsOf('Items');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'P-1');
  assert.equal(rows[0].type, 'Project');
  assert.equal(rows[0].title, 'Core banking DR site');
  assert.equal(rows[0].s, 'Ongoing');
  assert.equal(rows[0].createdBy, 'amina@example.com', 'the sheet records who created it');
});

test('editing an item rewrites that row and leaves the others alone', async () => {
  await call('POST', '/api/items', { token: tokens.admin, body: { type: 'Drive', title: 'Monthly backup test', f1: 'Sohel' } });
  await call('POST', '/api/items', { token: tokens.admin, body: { type: 'Task', title: 'Renew SSL', f1: 'Amina' } });
  assert.equal(google.rowsOf('Items').length, 3);

  const res = await call('PATCH', '/api/items/P-1', { token: tokens.admin, body: { s: 'On Hold', title: 'Core banking DR site (phase 2)' } });
  assert.equal(res.status, 200);

  const rows = google.rowsOf('Items');
  assert.equal(rows.length, 3, 'still three rows');
  const project = rows.find(r => r.id === 'P-1');
  assert.equal(project.s, 'On Hold');
  assert.equal(project.title, 'Core banking DR site (phase 2)');
  assert.equal(project.updatedBy, 'amina@example.com');
  assert.equal(rows.find(r => r.id === 'D-1').title, 'Monthly backup test', 'the neighbours are untouched');
});

test('deleting an item removes exactly that row', async () => {
  const before = google.rowsOf('Items').map(r => r.id);
  assert.deepEqual(before, ['P-1', 'D-1', 'T-1']);

  const res = await call('DELETE', '/api/items/D-1', { token: tokens.admin });
  assert.equal(res.status, 200);

  const after = google.rowsOf('Items').map(r => r.id);
  assert.deepEqual(after, ['P-1', 'T-1'], 'the right row went, and the rest stayed in order');
  assert.equal((await call('GET', '/api/items', { token: tokens.admin })).body.items.length, 2);
});

test('ids keep counting up per type even after a deletion', async () => {
  const res = await call('POST', '/api/items', { token: tokens.admin, body: { type: 'Drive', title: 'Weekly patching', f1: 'Amina' } });
  assert.equal(res.body.id, 'D-2', 'D-1 was used and deleted, so its id is not handed out again');
  await call('DELETE', `/api/items/${res.body.id}`, { token: tokens.admin });

  const third = await call('POST', '/api/items', { token: tokens.admin, body: { type: 'Drive', title: 'Third', f1: 'Amina' } });
  assert.equal(third.body.id, 'D-3', 'the counter keeps climbing');
  await call('DELETE', `/api/items/${third.body.id}`, { token: tokens.admin });
});

/* ---------------------------------------------------------------- roles, over the sheet */
test('superuser: writes Tasks only, and the sheet proves nothing else changed', async () => {
  const task = await call('POST', '/api/items', { token: tokens.superuser, body: { type: 'Task', title: 'Replace UPS battery', f1: 'Sohel' } });
  assert.equal(task.status, 201);
  assert.ok(google.rowsOf('Items').some(r => r.title === 'Replace UPS battery' && r.createdBy === 'sohel@example.com'));

  for (const type of ['Project', 'Drive']) {
    const res = await call('POST', '/api/items', { token: tokens.superuser, body: { type, title: 'Refused', f1: 'Sohel' } });
    assert.equal(res.status, 403, type);
  }
  assert.ok(!google.rowsOf('Items').some(r => r.title === 'Refused'), 'nothing refused reached the sheet');

  /* the stored type decides, so a project cannot be edited by calling it a task */
  const sneaky = await call('PATCH', '/api/items/P-1', { token: tokens.superuser, body: { type: 'Task', title: 'hijacked' } });
  assert.equal(sneaky.status, 403);
  assert.ok(!google.rowsOf('Items').some(r => r.title === 'hijacked'));

  await call('DELETE', `/api/items/${task.body.id}`, { token: tokens.admin });
});

test('viewer: reads the sheet and cannot change a single cell', async () => {
  const before = JSON.stringify(google.rowsOf('Items'));

  assert.equal((await call('GET', '/api/items', { token: tokens.viewer })).status, 200);
  for (const type of ['Project', 'Drive', 'Task']) {
    assert.equal((await call('POST', '/api/items', { token: tokens.viewer, body: { type, title: 'No', f1: 'Vik' } })).status, 403);
  }
  assert.equal((await call('PATCH', '/api/items/P-1', { token: tokens.viewer, body: { s: 'Done' } })).status, 403);
  assert.equal((await call('DELETE', '/api/items/P-1', { token: tokens.viewer })).status, 403);
  assert.equal((await call('GET', '/api/export', { token: tokens.viewer })).status, 403);

  assert.equal(JSON.stringify(google.rowsOf('Items')), before, 'the Items tab is byte for byte unchanged');
});

test('only the super admin may manage users, and the sheet shows it', async () => {
  assert.equal((await call('GET', '/api/users', { token: tokens.admin })).status, 403);
  assert.equal((await call('GET', '/api/users', { token: tokens.superuser })).status, 403);
  assert.equal((await call('POST', '/api/users', {
    token: tokens.viewer, body: { email: 'x@y.com', name: 'X', role: 'admin', password: 'pw12' },
  })).status, 403);
  assert.equal(google.rowsOf('Users').length, 4, 'no new account was written');
});

test('a role change is written to the sheet and ends the old session', async () => {
  const res = await call('PATCH', '/api/users/vik@example.com', { token: tokens.superadmin, body: { role: 'admin' } });
  assert.equal(res.status, 200);
  assert.equal(google.rowsOf('Users').find(r => r.email === 'vik@example.com').role, 'admin');

  assert.equal((await call('GET', '/api/auth/me', { token: tokens.viewer })).body.user, null);
  assert.ok(!google.rowsOf('Sessions').some(r => r.email === 'vik@example.com'), 'the session row went too');

  await call('PATCH', '/api/users/vik@example.com', { token: tokens.superadmin, body: { role: 'viewer' } });
  tokens.viewer = await login('vik@example.com', 'viewerpw');
});

test('removing an account removes its row', async () => {
  await call('POST', '/api/users', {
    token: tokens.superadmin, body: { email: 'temp@example.com', name: 'Temp', role: 'viewer', password: 'temppw1' },
  });
  assert.equal(google.rowsOf('Users').length, 5);
  assert.equal((await call('DELETE', '/api/users/temp@example.com', { token: tokens.superadmin })).status, 200);
  const rows = google.rowsOf('Users');
  assert.equal(rows.length, 4);
  assert.ok(!rows.some(r => r.email === 'temp@example.com'));
  assert.ok(rows.some(r => r.email === 'boss@tracker.com'), 'the others survived the row deletion');
});

/* ---------------------------------------------------------------- the rest of the data */
test('the audit trail is appended to its own tab', async () => {
  const rows = google.rowsOf('Audit');
  const actions = rows.map(r => r.action);
  for (const expected of ['login', 'user.create', 'item.create', 'item.update', 'item.delete', 'user.update']) {
    assert.ok(actions.includes(expected), `the Audit tab should record "${expected}"`);
  }
  const create = rows.find(r => r.action === 'item.create');
  assert.ok(create.actor, 'each entry names who did it');
  assert.ok(create.at, 'and when');
});

test('an access request lands in its tab and clears when approved', async () => {
  await call('POST', '/api/requests', { body: { id: 'visitor-1', email: 'new@example.com', name: 'New Person' } });
  assert.equal(google.rowsOf('Requests').length, 1);

  await call('POST', '/api/users', {
    token: tokens.superadmin,
    body: { email: 'new@example.com', name: 'New Person', role: 'superuser', password: 'welcome1', requestId: 'visitor-1' },
  });
  assert.equal(google.rowsOf('Requests').length, 0, 'approving clears the request row');
  assert.ok(google.rowsOf('Users').some(r => r.email === 'new@example.com' && r.role === 'superuser'));
});

test('the task archive round-trips through its tab', async () => {
  const rows = [{ id: 'T-900', type: 'Task', title: 'Old task', s: 'Done', f1: 'A' }];
  assert.equal((await call('PUT', '/api/items/archive/batch-1', { token: tokens.admin, body: { rows } })).status, 200);
  assert.equal(google.rowsOf('Archive').length, 1);

  const back = await call('GET', '/api/items/archive', { token: tokens.viewer });
  assert.deepEqual(back.body.batches[0].rows, rows);
});

test('a forgotten-password code is stored hashed in its tab and then cleared', async () => {
  await call('POST', '/api/auth/forgot', { body: { email: 'sohel@example.com' } });
  const stored = google.rowsOf('Resets');
  assert.equal(stored.length, 1);

  const mail = mailer.outbox[mailer.outbox.length - 1];
  const code = String(mail.subject).match(/\b(\d{6})\b/)[1];
  assert.ok(!stored[0].codeHash.includes(code), 'the code itself is never written to the sheet');

  const done = await call('POST', '/api/auth/reset', {
    body: { email: 'sohel@example.com', code, newPassword: 'freshpass' },
  });
  assert.equal(done.status, 200);
  assert.equal(google.rowsOf('Resets').length, 0, 'the spent code is removed');
  assert.ok(await login('sohel@example.com', 'freshpass'));
});

test('the dashboard figures and the export read from the sheet', async () => {
  const stats = await call('GET', '/api/stats', { token: tokens.admin });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.total, google.rowsOf('Items').length);

  const csv = await call('GET', '/api/export?format=csv', { token: tokens.admin });
  assert.equal(csv.status, 200);
  assert.match(String(csv.body.raw || ''), /ID,Type,Title,Status/);
});

test('the data survives a restart, because it was never in memory', async () => {
  const before = google.rowsOf('Items').map(r => r.id).sort();

  /* Drop the driver entirely and build a fresh one against the same spreadsheet. */
  await store.close();
  await store.init();
  const after = (await store.get().all('items')).map(r => r.id).sort();
  assert.deepEqual(after, before, 'a brand new connection sees exactly the same rows');

  const stillWorks = await call('GET', '/api/items', { token: tokens.admin });
  assert.equal(stillWorks.status, 200);
  assert.equal(stillWorks.body.items.length, before.length);
});

test('the service-account token was genuinely signed and accepted', () => {
  assert.ok(google.calls.some(c => c === 'POST /token'), 'the driver asked for a token');
  assert.ok(google.calls.filter(c => c === 'POST /token').length < 5,
    'and cached it rather than asking on every call');
});
