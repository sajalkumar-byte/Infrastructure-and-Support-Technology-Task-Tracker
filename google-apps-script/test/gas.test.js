'use strict';
/* gas.test.js – tests the Google Sheets backend (Code.gs) before it is ever deployed.
   The Apps Script services are stood in for by test/harness.js; the code under test is the real
   file. Run with:  node --test google-apps-script/test/ */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

/* A fresh spreadsheet, a super admin, and one account per role. */
function freshWorld() {
  const world = load();
  const { call, sandbox } = world;
  sandbox.setupTracker();

  const boss = call('login', { email: 'admin@tracker.com', password: 'Admin@1234' });
  assert.ok(boss.token, 'the seeded super admin should be able to sign in');

  const tokens = { superadmin: boss.token };
  const accounts = [
    { email: 'amina@example.com', name: 'Amina', role: 'admin', password: 'adminpw' },
    { email: 'sohel@example.com', name: 'Sohel', role: 'superuser', password: 'superpw' },
    { email: 'vik@example.com', name: 'Vik', role: 'viewer', password: 'viewerpw' },
  ];
  for (const account of accounts) {
    const res = call('createUser', { ...account, token: tokens.superadmin });
    assert.ok(!res.error, `creating ${account.role}: ${JSON.stringify(res.error)}`);
    tokens[account.role] = call('login', { email: account.email, password: account.password }).token;
  }
  return { ...world, tokens };
}

test('setup creates the sheets and one super admin', () => {
  const { call, spreadsheet, sandbox } = load();
  assert.equal(call('health').setupRequired, true);
  sandbox.setupTracker();

  /* The script's own tabs are created, named so nobody mistakes them for working tabs, and
     hidden. The team's items tab is left exactly as it was - setup never writes to it. */
  for (const name of ['Tracker Users', 'Tracker Item Meta', 'Tracker Sessions',
                      'Tracker Requests', 'Tracker Archive', 'Tracker Audit']) {
    const tab = spreadsheet.getSheetByName(name);
    assert.ok(tab, `the ${name} tab should exist`);
    assert.equal(tab.hidden, true, `${name} should be out of the way`);
  }
  assert.ok(!spreadsheet.getSheetByName('Items'), 'no tab of its own for items');
  const team = spreadsheet.getSheetByName('IS Project & Drive');
  assert.equal(team.getLastRow(), 1, 'the team tab still holds only its header row');
  assert.equal(call('health').setupRequired, false);

  /* The password is hashed in the sheet, never stored as typed. */
  const users = spreadsheet.getSheetByName('Tracker Users');
  const row = users.getRange(2, 1, 1, 9).getValues()[0];
  assert.equal(row[0], 'admin@tracker.com');
  assert.match(String(row[3]), /^sha256\$\d+\$/);
  assert.ok(!String(row[3]).includes('Admin@1234'));
});

test('setup cannot be run twice to grab a second super admin', () => {
  const { call, sandbox } = load();
  sandbox.setupTracker();
  const res = call('setup', { name: 'Intruder', email: 'intruder@example.com', password: 'hunter2' });
  assert.equal(res.error.code, 'already_setup');
});

test('a wrong password is refused and a right one is accepted', () => {
  const { call, sandbox } = load();
  sandbox.setupTracker();
  assert.equal(call('login', { email: 'admin@tracker.com', password: 'wrong' }).error.code, 'unauthorized');
  assert.ok(call('login', { email: 'ADMIN@Tracker.com', password: 'Admin@1234' }).token, 'email case must not matter');
});

/* ---------------------------------------------------------------- SUPERUSER */
test('superuser: is told it may write Tasks only', () => {
  const { call, tokens } = freshWorld();
  const me = call('me', { token: tokens.superuser });
  assert.equal(me.user.role, 'superuser');
  assert.deepEqual(me.permissions.writableTypes, ['Task']);
  assert.equal(me.permissions.export, true);
  assert.equal(me.permissions.manageUsers, false);
});

test('superuser: can create, edit, change status of and delete a Task', () => {
  const { call, tokens } = freshWorld();
  const created = call('saveItem', {
    token: tokens.superuser,
    item: { type: 'Task', title: 'Replace UPS battery', f1: 'Sohel', pri: 'High' },
  });
  assert.ok(!created.error, JSON.stringify(created.error));
  assert.match(created.id, /^T-\d+$/);
  assert.equal(created.s, 'Ongoing');
  assert.equal(created.createdBy, 'sohel@example.com');

  const edited = call('saveItem', { token: tokens.superuser, id: created.id, item: { s: 'On Hold', title: 'UPS battery – HO' } });
  assert.equal(edited.s, 'On Hold');
  assert.equal(edited.title, 'UPS battery – HO');
  assert.equal(edited.type, 'Task', 'the type must survive a partial edit');

  assert.equal(call('deleteItem', { token: tokens.superuser, id: created.id }).ok, true);
  assert.equal(call('listItems', { token: tokens.superuser }).items.length, 0);
});

test('superuser: cannot create a Project or a Recurring item', () => {
  const { call, tokens } = freshWorld();
  for (const type of ['Project', 'Drive']) {
    const res = call('saveItem', { token: tokens.superuser, item: { type, title: 'No', f1: 'Sohel' } });
    assert.equal(res.error.code, 'forbidden', type);
    assert.match(res.error.message, /Superuser/);
  }
});

test('superuser: cannot touch a Project by pretending it is a Task', () => {
  const { call, tokens } = freshWorld();
  const project = call('saveItem', { token: tokens.admin, item: { type: 'Project', title: 'Core banking DR', f1: 'Amina' } });
  assert.match(project.id, /^P-\d+$/);

  const sneaky = call('saveItem', { token: tokens.superuser, id: project.id, item: { type: 'Task', title: 'hijacked' } });
  assert.equal(sneaky.error.code, 'forbidden');

  assert.equal(call('deleteItem', { token: tokens.superuser, id: project.id }).error.code, 'forbidden');
  assert.equal(call('listItems', { token: tokens.superuser }).items[0].title, 'Core banking DR');
});

test('superuser: sees everything and may export, but not manage users', () => {
  const { call, tokens } = freshWorld();
  call('saveItem', { token: tokens.admin, item: { type: 'Project', title: 'Visible', f1: 'Amina' } });

  assert.equal(call('listItems', { token: tokens.superuser }).items.length, 1);
  assert.equal(typeof call('stats', { token: tokens.superuser }).total, 'number');

  const exported = call('exportData', { token: tokens.superuser });
  assert.equal(exported.rows.length, 1);
  assert.equal(exported.columns[0], 'ID');

  assert.equal(call('listUsers', { token: tokens.superuser }).error.code, 'forbidden');
  assert.equal(call('audit', { token: tokens.superuser }).error.code, 'forbidden');
});

/* ---------------------------------------------------------------- ADMIN */
test('admin: may write every type but not manage users', () => {
  const { call, tokens } = freshWorld();
  const ids = [];
  for (const [type, title] of [['Project', 'Wi-Fi rollout'], ['Drive', 'Backup test'], ['Task', 'Renew SSL']]) {
    const res = call('saveItem', { token: tokens.admin, item: { type, title, f1: 'Amina' } });
    assert.ok(!res.error, `${type}: ${JSON.stringify(res.error)}`);
    ids.push(res.id);
  }
  assert.match(ids[0], /^P-/); assert.match(ids[1], /^D-/); assert.match(ids[2], /^T-/);

  assert.ok(!call('exportData', { token: tokens.admin }).error);
  assert.equal(call('listUsers', { token: tokens.admin }).error.code, 'forbidden');
  assert.equal(call('createUser', {
    token: tokens.admin, email: 'x@y.com', name: 'X', role: 'admin', password: 'pw12',
  }).error.code, 'forbidden');
});

/* ---------------------------------------------------------------- VIEWER */
test('viewer: reads everything and changes nothing', () => {
  const { call, tokens } = freshWorld();
  const item = call('saveItem', { token: tokens.admin, item: { type: 'Task', title: 'Look only', f1: 'Amina' } });

  assert.equal(call('listItems', { token: tokens.viewer }).items.length, 1);
  assert.ok(!call('stats', { token: tokens.viewer }).error);

  for (const type of ['Project', 'Drive', 'Task']) {
    assert.equal(call('saveItem', { token: tokens.viewer, item: { type, title: 'No', f1: 'Vik' } }).error.code, 'forbidden');
  }
  assert.equal(call('saveItem', { token: tokens.viewer, id: item.id, item: { s: 'Done' } }).error.code, 'forbidden');
  assert.equal(call('deleteItem', { token: tokens.viewer, id: item.id }).error.code, 'forbidden');

  const exported = call('exportData', { token: tokens.viewer });
  assert.equal(exported.error.code, 'forbidden');
  assert.match(exported.error.message, /download or print/);
});

/* ---------------------------------------------------------------- SUPER ADMIN */
test('super admin: manages users without ever exposing a password', () => {
  const { call, tokens } = freshWorld();
  const list = call('listUsers', { token: tokens.superadmin });
  /* two seeded by setup, three made by the test */
  assert.equal(list.users.length, 5);
  for (const u of list.users) assert.ok(!('password' in u), `${u.email} leaked its password`);
});

test('super admin: a role change ends the old sessions immediately', () => {
  const { call, tokens } = freshWorld();
  assert.equal(call('me', { token: tokens.viewer }).user.role, 'viewer');

  const changed = call('updateUser', { token: tokens.superadmin, email: 'vik@example.com', role: 'admin' });
  assert.equal(changed.role, 'admin');

  /* The old token is dead, so stale rights cannot linger. */
  assert.equal(call('me', { token: tokens.viewer }).user, null);

  const fresh = call('login', { email: 'vik@example.com', password: 'viewerpw' }).token;
  assert.ok(!call('saveItem', { token: fresh, item: { type: 'Project', title: 'Now allowed', f1: 'Vik' } }).error);
});

test('super admin: resets a password, and only the new one works', () => {
  const { call, tokens } = freshWorld();
  assert.ok(!call('updateUser', { token: tokens.superadmin, email: 'sohel@example.com', password: 'brandnew' }).error);
  assert.equal(call('login', { email: 'sohel@example.com', password: 'superpw' }).error.code, 'unauthorized');
  assert.ok(call('login', { email: 'sohel@example.com', password: 'brandnew' }).token);
});

test('super admin: cannot lock everyone out', () => {
  const { call, tokens } = freshWorld();
  assert.equal(call('updateUser', { token: tokens.superadmin, email: 'admin@tracker.com', role: 'viewer' }).error.code, 'self_role');
  assert.equal(call('deleteUser', { token: tokens.superadmin, email: 'admin@tracker.com' }).error.code, 'self_delete');
});

test('super admin: duplicate emails are refused', () => {
  const { call, tokens } = freshWorld();
  const res = call('createUser', {
    token: tokens.superadmin, email: 'Amina@Example.com', name: 'Copy', role: 'viewer', password: 'pw1234',
  });
  assert.equal(res.error.code, 'conflict');
});

test('super admin: removing an account also ends its session', () => {
  const { call, tokens } = freshWorld();
  assert.ok(call('deleteUser', { token: tokens.superadmin, email: 'vik@example.com' }).ok);
  assert.equal(call('me', { token: tokens.viewer }).user, null);
  assert.equal(call('listItems', { token: tokens.viewer }).error.code, 'unauthorized');
});

test('super admin: the audit log records what happened', () => {
  const { call, tokens } = freshWorld();
  call('saveItem', { token: tokens.admin, item: { type: 'Task', title: 'Audited', f1: 'Amina' } });
  call('exportData', { token: tokens.admin });

  const log = call('audit', { token: tokens.superadmin });
  const actions = log.entries.map(e => e.action);
  for (const expected of ['login', 'user.create', 'item.create', 'export']) {
    assert.ok(actions.includes(expected), `the audit log should record "${expected}"`);
  }
});

/* ---------------------------------------------------------------- access and validation */
test('no token means no access', () => {
  const { call } = freshWorld();
  for (const action of ['listItems', 'stats', 'exportData', 'listUsers', 'audit']) {
    assert.equal(call(action).error.code, 'unauthorized', action);
  }
  assert.equal(call('listItems', { token: 'made-up' }).error.code, 'unauthorized');
});

test('signing out stops the token working', () => {
  const { call, tokens } = freshWorld();
  assert.ok(call('logout', { token: tokens.admin }).ok);
  assert.equal(call('listItems', { token: tokens.admin }).error.code, 'unauthorized');
});

test('items are validated rather than trusted', () => {
  const { call, tokens } = freshWorld();
  const cases = [
    [{ type: 'Nonsense', title: 'x', f1: 'y' }, 'bad_type'],
    [{ type: 'Task', title: '', f1: 'y' }, 'bad_title'],
    [{ type: 'Task', title: 'x', f1: '' }, 'bad_focal'],
    [{ type: 'Task', title: 'x', f1: 'y', s: 'Flying' }, 'bad_status'],
    [{ type: 'Task', title: 'x', f1: 'y', pri: 'Urgent' }, 'bad_priority'],
    [{ type: 'Task', title: 'x', f1: 'y', sd: '14-10-2026' }, 'bad_date'],
  ];
  for (const [item, code] of cases) {
    assert.equal(call('saveItem', { token: tokens.admin, item }).error.code, code, JSON.stringify(item));
  }
});

test('accounts are validated too', () => {
  const { call, tokens } = freshWorld();
  const base = { token: tokens.superadmin, name: 'X', role: 'admin', password: 'pw12' };
  assert.equal(call('createUser', { ...base, email: 'not-an-email' }).error.code, 'bad_email');
  assert.equal(call('createUser', { ...base, email: 'a@b.com', role: 'wizard' }).error.code, 'bad_role');
  assert.equal(call('createUser', { ...base, email: 'a@b.com', password: 'x' }).error.code, 'bad_password');
  assert.equal(call('createUser', { ...base, email: 'a@b.com', name: '' }).error.code, 'bad_name');
});

test('repeated wrong passwords are throttled', () => {
  const { call } = freshWorld();
  let blocked = false;
  for (let i = 0; i < 12; i++) {
    const res = call('login', { email: 'admin@tracker.com', password: 'wrong' });
    if (res.error.code === 'rate_limited') { blocked = true; break; }
  }
  assert.ok(blocked, 'the script should start refusing after several failed attempts');
});

test('changing your own password needs the current one', () => {
  const { call, tokens } = freshWorld();
  const refused = call('changePassword', { token: tokens.admin, currentPassword: 'nope', newPassword: 'longenough' });
  assert.equal(refused.error.code, 'bad_current');
  assert.equal(refused.error.status, 400, 'a mistyped password must not look like an expired session');
  assert.equal(call('me', { token: tokens.admin }).user.email, 'amina@example.com', 'and must not sign them out');

  const ok = call('changePassword', { token: tokens.admin, currentPassword: 'adminpw', newPassword: 'adminpw2' });
  assert.equal(ok.ok, true);
  assert.equal(call('me', { token: tokens.admin }).user.email, 'amina@example.com',
    'the device you changed it on stays signed in');
  assert.equal(call('login', { email: 'amina@example.com', password: 'adminpw' }).error.code, 'unauthorized');
  assert.ok(call('login', { email: 'amina@example.com', password: 'adminpw2' }).token);
});

test('access requests: anyone may ask, only the super admin may approve', () => {
  const { call, tokens } = freshWorld();
  assert.equal(call('createRequest', { id: 'visitor-1', email: 'new@example.com', name: 'New Person' }).ok, true);
  assert.equal(call('deleteRequest', { token: tokens.viewer, id: 'visitor-1' }).error.code, 'forbidden');
  assert.equal(call('listUsers', { token: tokens.superadmin }).requests.length, 1);

  const approved = call('createUser', {
    token: tokens.superadmin, email: 'new@example.com', name: 'New Person',
    role: 'superuser', password: 'welcome1', requestId: 'visitor-1',
  });
  assert.ok(!approved.error);
  assert.equal(call('listUsers', { token: tokens.superadmin }).requests.length, 0);
});

test('item ids keep counting up per type', () => {
  const { call, tokens } = freshWorld();
  const a = call('saveItem', { token: tokens.admin, item: { type: 'Task', title: 'One', f1: 'A' } });
  const b = call('saveItem', { token: tokens.admin, item: { type: 'Task', title: 'Two', f1: 'A' } });
  const p = call('saveItem', { token: tokens.admin, item: { type: 'Project', title: 'Three', f1: 'A' } });
  assert.equal(Number(b.id.slice(2)), Number(a.id.slice(2)) + 1);
  assert.match(p.id, /^P-1$/, 'each type numbers independently');

  /* Deleting the newest and adding again must not reuse a live id. */
  call('deleteItem', { token: tokens.admin, id: b.id });
  const c = call('saveItem', { token: tokens.admin, item: { type: 'Task', title: 'Four', f1: 'A' } });
  assert.notEqual(c.id, a.id);
});

test('the archive round-trips through the sheet', () => {
  const { call, tokens } = freshWorld();
  const rows = [{ id: 'T-900', type: 'Task', title: 'Old task', s: 'Done', f1: 'A' }];
  assert.ok(!call('saveArchive', { token: tokens.admin, id: 'batch-1', rows }).error);

  const back = call('listArchive', { token: tokens.viewer });
  assert.equal(back.batches.length, 1);
  assert.deepEqual(back.batches[0].rows, rows);

  assert.equal(call('saveArchive', { token: tokens.superuser, id: 'batch-2', rows: [] }).error.code, 'forbidden');
});

test('unknown actions are reported, not silently ignored', () => {
  const { call, tokens } = freshWorld();
  assert.equal(call('dropAllTables', { token: tokens.superadmin }).error.code, 'not_found');
});

/* ---------------------------------------------------------------- sample data helpers */
test('addSampleData refuses to invent rows in a working tab, unless told to', () => {
  /* The rows would land in the team's own tab, among real work. On a sheet made for trying
     the app out that is the point; here it has to be asked for. */
  const { sandbox, spreadsheet, properties, logs } = load();
  sandbox.setupTracker();

  assert.equal(sandbox.addSampleData(), 0);
  assert.equal(spreadsheet.getSheetByName('IS Project & Drive').getLastRow(), 1, 'nothing written');
  assert.match(logs.join(' '), /Refused/);

  properties.set('ALLOW_SAMPLE_DATA', 'yes');
  const added = sandbox.addSampleData();
  assert.ok(added > 0, 'with permission it writes the samples');
  assert.equal(sandbox.addSampleData(), 0, 'and running it again adds nothing');
});
test('addSampleUsers creates one working account per role', () => {
  const { call, sandbox } = freshWorld();
  assert.equal(sandbox.addSampleUsers(), 3);

  const checks = [
    ['admin2@tracker.com', 'Admin2@1234', 'admin'],
    ['superuser@tracker.com', 'Super@1234', 'superuser'],
    ['viewer@tracker.com', 'Viewer@1234', 'viewer'],
  ];
  for (const [email, password, role] of checks) {
    const session = call('login', { email, password });
    assert.ok(session.token, `${email} should be able to sign in`);
    assert.equal(session.user.role, role);
  }
  assert.equal(sandbox.addSampleUsers(), 0, 'running it again changes nothing');
});

test('checkDeployment reports a healthy install and spots a broken one', () => {
  const { sandbox } = freshWorld();
  /* the array comes from the sandbox's own realm, so compare its contents, not its identity */
  assert.equal(sandbox.checkDeployment().length, 0, 'a fresh install has no problems');

  /* a password typed straight into the sheet instead of being hashed is caught */
  const users = sandbox.readTable_('users');
  users[1].password = 'plaintext123';
  sandbox.writeTable_('users', users);
  const problems = sandbox.checkDeployment();
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not hashed/);
});

/* ---------------------------------------------------------------- forgotten password */
function codeFromOutbox(outbox) {
  const mail = outbox[outbox.length - 1];
  assert.ok(mail, 'an email should have been sent');
  const match = String(mail.subject + ' ' + mail.body).match(/\b(\d{6})\b/);
  assert.ok(match, 'the email should carry a six-digit code');
  return match[1];
}

/* Emailing a reset code is off by default - the tracker does not need it, and a super admin
   can set a password from the Team tab. These tests turn it on, because they are about what it
   does when it is on; the test right below is about it being off. */
function worldWithEmail() {
  const world = freshWorld();
  world.sandbox.ALLOW_EMAIL_RESET = true;
  return world;
}

test('forgot password: it is off unless it is switched on, and says so', () => {
  const { call, outbox } = freshWorld();
  const asked = call('forgotPassword', { email: 'sohel@example.com' });
  assert.equal(asked.error.code, 'mail_off');
  assert.match(asked.error.message, /super admin/);
  assert.equal(outbox.length, 0, 'nothing is sent');
  assert.equal(call('health', {}).email, false, 'and the page is told not to offer it');
});

test('forgot password: a code arrives by email and changes the password', () => {
  const { call, outbox } = worldWithEmail();

  const asked = call('forgotPassword', { email: 'sohel@example.com' });
  assert.equal(asked.ok, true);
  assert.match(asked.message, /six-digit code/);

  const mail = outbox[outbox.length - 1];
  assert.equal(mail.to, 'sohel@example.com');
  assert.match(mail.subject, /password code/i);
  assert.ok(mail.htmlBody.includes('Sohel'), 'the email greets the person by name');

  const code = codeFromOutbox(outbox);
  const done = call('resetPassword', { email: 'sohel@example.com', code, newPassword: 'freshpass' });
  assert.equal(done.ok, true);

  assert.equal(call('login', { email: 'sohel@example.com', password: 'superpw' }).error.code, 'unauthorized');
  const session = call('login', { email: 'sohel@example.com', password: 'freshpass' });
  assert.ok(session.token);
  assert.equal(session.user.role, 'superuser', 'the role is untouched by a password reset');
});

test('forgot password: the code is not stored in a usable form', () => {
  const { call, sandbox, outbox } = worldWithEmail();
  call('forgotPassword', { email: 'vik@example.com' });
  const code = codeFromOutbox(outbox);

  const rows = sandbox.readTable_('resets');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'vik@example.com');
  assert.ok(!String(rows[0].codeHash).includes(code), 'the sheet must not hold the code itself');
  assert.equal(String(rows[0].codeHash).length, 64, 'it holds a SHA-256 hash instead');
});

test('forgot password: an unknown address gets the same answer and no email', () => {
  const { call, outbox } = worldWithEmail();
  const before = outbox.length;
  const res = call('forgotPassword', { email: 'nobody@example.com' });
  assert.equal(res.ok, true, 'the answer must not reveal who has an account');
  assert.match(res.message, /If that address has an account/);
  assert.equal(outbox.length, before, 'but nothing is actually sent');
});

test('forgot password: a wrong code is refused and runs out of tries', () => {
  const { call, outbox } = worldWithEmail();
  call('forgotPassword', { email: 'vik@example.com' });
  const code = codeFromOutbox(outbox);
  const wrong = code === '000000' ? '111111' : '000000';

  for (let i = 1; i <= 5; i++) {
    const res = call('resetPassword', { email: 'vik@example.com', code: wrong, newPassword: 'whatever1' });
    assert.equal(res.error.code, 'bad_code', `attempt ${i}`);
  }
  /* the sixth attempt throws the code away, so even the right one no longer works */
  assert.equal(call('resetPassword', { email: 'vik@example.com', code: wrong, newPassword: 'whatever1' }).error.code, 'too_many_tries');
  assert.equal(call('resetPassword', { email: 'vik@example.com', code, newPassword: 'whatever1' }).error.code, 'bad_code');
  assert.ok(call('login', { email: 'vik@example.com', password: 'viewerpw' }).token, 'the old password still works');
});

test('forgot password: an expired code is refused', () => {
  const { call, sandbox, outbox } = worldWithEmail();
  call('forgotPassword', { email: 'vik@example.com' });
  const code = codeFromOutbox(outbox);

  const rows = sandbox.readTable_('resets');
  rows[0].expiresAt = new Date(Date.now() - 60000).toISOString();
  sandbox.writeTable_('resets', rows);

  const res = call('resetPassword', { email: 'vik@example.com', code, newPassword: 'whatever1' });
  assert.equal(res.error.code, 'expired_code');
  assert.equal(sandbox.readTable_('resets').length, 0, 'the spent code is cleared away');
});

test('forgot password: a code cannot be used twice', () => {
  const { call, outbox } = worldWithEmail();
  call('forgotPassword', { email: 'vik@example.com' });
  const code = codeFromOutbox(outbox);
  assert.equal(call('resetPassword', { email: 'vik@example.com', code, newPassword: 'firstpass' }).ok, true);
  assert.equal(call('resetPassword', { email: 'vik@example.com', code, newPassword: 'secondpass' }).error.code, 'bad_code');
  assert.ok(call('login', { email: 'vik@example.com', password: 'firstpass' }).token);
});

test('forgot password: a reset signs that person out everywhere', () => {
  const { call, tokens, outbox } = worldWithEmail();
  assert.equal(call('me', { token: tokens.viewer }).user.email, 'vik@example.com');

  call('forgotPassword', { email: 'vik@example.com' });
  call('resetPassword', { email: 'vik@example.com', code: codeFromOutbox(outbox), newPassword: 'brandnew1' });

  assert.equal(call('me', { token: tokens.viewer }).user, null, 'the old session is dead');
});

test('forgot password: one address cannot be used to send a flood of email', () => {
  const { call, outbox } = worldWithEmail();
  let blocked = false;
  for (let i = 0; i < 10; i++) {
    const res = call('forgotPassword', { email: 'vik@example.com' });
    if (res.error && res.error.code === 'rate_limited') { blocked = true; break; }
  }
  assert.ok(blocked, 'the script should stop sending after several requests');
  assert.ok(outbox.length <= 5, `at most five emails, got ${outbox.length}`);
});

test('forgot password: input is checked', () => {
  const { call, outbox } = worldWithEmail();
  assert.equal(call('forgotPassword', { email: 'not-an-email' }).error.code, 'bad_email');
  call('forgotPassword', { email: 'vik@example.com' });
  const code = codeFromOutbox(outbox);
  assert.equal(call('resetPassword', { email: 'vik@example.com', code, newPassword: 'ab' }).error.code, 'bad_password');
  assert.equal(call('resetPassword', { email: 'vik@example.com', code: '', newPassword: 'goodpass' }).error.code, 'bad_code');
});

test('forgot password: works without being signed in', () => {
  const { call } = worldWithEmail();
  /* no token is passed anywhere in this test, which is the whole point */
  const res = call('forgotPassword', { email: 'amina@example.com' });
  assert.equal(res.ok, true);
});

/* ---------------------------------------------------------------- own profile */
test('profile: anyone signed in can change their own name, but not their role', () => {
  const { call, tokens } = freshWorld();

  const updated = call('updateProfile', { token: tokens.viewer, name: 'Nadia R. Rahman' });
  assert.equal(updated.name, 'Nadia R. Rahman');
  assert.equal(updated.role, 'viewer', 'the role is untouched');
  assert.equal(call('me', { token: tokens.viewer }).user.name, 'Nadia R. Rahman');

  /* a role cannot be smuggled in through this endpoint */
  call('updateProfile', { token: tokens.viewer, name: 'Nadia', role: 'superadmin' });
  assert.equal(call('me', { token: tokens.viewer }).user.role, 'viewer');

  assert.equal(call('updateProfile', { token: tokens.viewer, name: '  ' }).error.code, 'bad_name');
  assert.equal(call('updateProfile', { name: 'Nobody' }).error.code, 'unauthorized');
});

test('changing your own password signs out your other devices only', () => {
  const { call } = freshWorld();
  const here = call('login', { email: 'vik@example.com', password: 'viewerpw' }).token;
  const elsewhere = call('login', { email: 'vik@example.com', password: 'viewerpw' }).token;

  assert.equal(call('changePassword', { token: here, currentPassword: 'viewerpw', newPassword: 'nextone1' }).ok, true);

  assert.equal(call('me', { token: here }).user.email, 'vik@example.com', 'this device stays signed in');
  assert.equal(call('me', { token: elsewhere }).user, null, 'the other device is signed out');
});

test('a start and end date come back as the days that were entered', () => {
  /* Sheets treats "2026-10-01" in a cell as a date, and a spreadsheet east of Greenwich hands
     it back as midnight local time – the evening before in UTC. Read back naively, every
     project started and ended a day early. */
  const { call, tokens } = freshWorld();

  const made = call('saveItem', {
    token: tokens.superadmin,
    item: {
      type: 'Project', title: 'Branch switch refresh', f1: 'Jason',
      s: 'Ongoing', pri: 'High', sd: '2026-10-01', e: '2026-12-20',
    },
  });
  assert.equal(made.sd, '2026-10-01');
  assert.equal(made.e, '2026-12-20');

  const stored = call('listItems', { token: tokens.superadmin }).items
    .find(i => i.id === made.id);
  assert.equal(stored.sd, '2026-10-01', 'the start date must survive the trip to the sheet');
  assert.equal(stored.e, '2026-12-20', 'and so must the end date');
  assert.equal(stored.createdAt.slice(0, 4), String(new Date().getFullYear()),
    'timestamps stay full ISO, they are not days');
});

test('a date typed into the team tab by hand is read as that day', () => {
  /* People type dates into this tab in several shapes. All of them have to come back as the
     same day the page would show, with no timezone able to shift it. */
  const { call, tokens, spreadsheet } = freshWorld();
  const made = call('saveItem', {
    token: tokens.superadmin,
    item: { type: 'Task', title: 'Swap the UPS battery', f1: 'Riad', s: 'Ongoing', pri: 'Mid' },
  });

  const sheet = spreadsheet.getSheetByName('IS Project & Drive');
  const row = sheet.rows.findIndex(line => line[0] === made.id) + 1;
  const END = 10;                                      // their End Date column

  for (const [typed, expected] of [
    ['5-Nov-2026', '2026-11-05'],
    ['12 Dec 2026', '2026-12-12'],
    ['01.07.2026', '2026-07-01'],
    ['2026-08-09', '2026-08-09'],
  ]) {
    sheet.getRange(row, END, 1, 1).setValues([[typed]]);
    const back = call('listItems', { token: tokens.superadmin }).items.find(i => i.id === made.id);
    assert.equal(back.e, expected, `typed as ${typed}`);
  }
});
test('setup seeds both of the accounts the sign-in page offers', () => {
  /* The page lists a super admin and an Admin whether or not a server is connected. An Admin
     that existed only in the browser could sign in offline, create a project, and leave it on
     that one device while the spreadsheet refused the same password. */
  const { call, sandbox } = load();
  sandbox.setupTracker();

  const admin = call('login', { email: 'testadmin@gmail.com', password: 'testpass' });
  assert.equal(admin.user.role, 'admin', JSON.stringify(admin.error || {}));

  const made = call('saveItem', {
    token: admin.token,
    item: { type: 'Project', title: 'Core banking upgrade', f1: 'test admin', s: 'Ongoing', pri: 'High' },
  });
  assert.ok(!made.error, 'an Admin must be able to create a project');
  assert.equal(made.createdBy, 'testadmin@gmail.com');

  const stored = call('listItems', { token: admin.token }).items;
  assert.equal(stored.length, 1, 'and it must be in the sheet, not only in the reply');
  assert.equal(stored[0].title, 'Core banking upgrade');
});

/* ---------------------------------------------------------------- THE ROLE TABS */
test('the role tabs are built only when they are asked for', () => {
  const { sandbox, spreadsheet } = load();
  sandbox.setupTracker();

  /* Setup adds nothing to a workbook people keep by hand. */
  assert.ok(!spreadsheet.getSheetByName('Admin data'), 'setup does not add view tabs');
  sandbox.rebuildViews();

  const names = spreadsheet.getSheets().map(sh => sh.getName());
  for (const expected of [
    'Super admin data', 'Super admin Projects', 'Super admin Recurring', 'Super admin Tasks',
    'Admin data', 'Admin Projects', 'Admin Recurring', 'Admin Tasks',
    'Superuser data', 'Superuser Tasks',
    'Viewer data', 'Accounts by role',
  ]) {
    assert.ok(names.includes(expected), `the "${expected}" tab should exist`);
  }
  /* A Superuser cannot create a Project, so an always-empty tab for one is not made. */
  assert.ok(!names.includes('Superuser Projects'));
  assert.ok(!names.includes('Viewer Tasks'));
});

test('a role tab shows that role its own rows, split by type', () => {
  const { sandbox, spreadsheet } = load();
  sandbox.setupTracker();
  sandbox.rebuildViews();

  const role = name => spreadsheet.getSheetByName(name).getRange(2, 1).getFormula();

  /* Which role created a row is the script's own bookkeeping, so the view joins the team's
     tab to the hidden meta tab by id rather than reading a column added to their sheet. */
  const admin = role('Admin data');
  assert.match(admin, /FILTER\('IS Project & Drive'!A2:O/);
  assert.match(admin, /COUNTIFS\('Tracker Item Meta'!\$A\$2:\$A, 'IS Project & Drive'!A2:A, 'Tracker Item Meta'!\$B\$2:\$B, "admin"\)>0/);
  assert.match(role('Admin Projects'), /'IS Project & Drive'!B2:B="Project"/);
  assert.match(role('Admin Recurring'), /'IS Project & Drive'!B2:B="Drive"/);
  assert.match(role('Superuser Tasks'), /"superuser"\)>0, 'IS Project & Drive'!B2:B="Task"/);
  /* Grouped by type, then by id, and an empty tab rather than an error when there is nothing. */
  assert.match(role('Viewer data'), /^=IFERROR\(SORT\(.*, 2, TRUE, 1, TRUE\), ""\)$/);
});

test('the accounts tab never repeats a password', () => {
  const { sandbox, spreadsheet } = load();
  sandbox.setupTracker();
  sandbox.rebuildViews();
  const formula = spreadsheet.getSheetByName('Accounts by role').getRange(2, 1).getFormula();
  const passwordColumn = "'Tracker Users'!" + String.fromCharCode(65 + 3);  // email,name,role,password
  assert.ok(!formula.includes(passwordColumn + '2:'), 'the password column must be left out');
  assert.match(formula, /'Tracker Users'!C2:C/);                            // the role is there
});

test('an item records the role that created it, and editing does not rewrite it', () => {
  const { call, tokens } = freshWorld();

  const made = call('saveItem', {
    token: tokens.superuser,
    item: { type: 'Task', title: 'Reset the VPN tokens', f1: 'Sohel', s: 'Ongoing', pri: 'Mid' },
  });
  assert.equal(made.role, 'superuser');

  /* An admin editing a superuser's task must not make it the admin's row, and nobody can
     claim a role by sending one. */
  const edited = call('saveItem', {
    token: tokens.admin,
    id: made.id,
    item: { title: 'Reset the VPN tokens for field staff', role: 'admin' },
  });
  assert.equal(edited.role, 'superuser');
  assert.equal(edited.updatedBy, 'amina@example.com');
});

test('a row created before roles were recorded is put on the right tab', () => {
  const { call, tokens, sandbox, spreadsheet } = freshWorld();
  const made = call('saveItem', {
    token: tokens.admin,
    item: { type: 'Project', title: 'Core banking upgrade', f1: 'Amina', s: 'Ongoing', pri: 'High' },
  });

  /* Blank the role in the script's own bookkeeping, as an older version would have left it. */
  const meta = spreadsheet.getSheetByName('Tracker Item Meta');
  const line = meta.rows.findIndex(r => r[0] === made.id);
  meta.rows[line][2] = '';                                   // id, type, role, ...
  assert.equal(call('listItems', { token: tokens.admin }).items.find(i => i.id === made.id).role, '');

  assert.equal(sandbox.fillInItemRoles_(), 1);
  assert.equal(call('listItems', { token: tokens.admin }).items.find(i => i.id === made.id).role,
    'admin', 'the role comes from whoever created it');
});
test('a tab somebody typed over comes back when the views are rebuilt', () => {
  const { sandbox, spreadsheet } = load();
  sandbox.setupTracker();
  sandbox.rebuildViews();

  const tab = spreadsheet.getSheetByName('Admin Projects');
  tab.getRange(2, 1, 1, 1).setValues([['somebody pasted this over the formula']]);
  assert.equal(tab.getRange(2, 1).getFormula(), '');

  sandbox.rebuildViews();
  assert.match(spreadsheet.getSheetByName('Admin Projects').getRange(2, 1).getFormula(), /^=IFERROR/);
});

/* ---------------------------------------------------------------- CHAT */
test('chat: two people hold a conversation, and it is stored in the sheet', () => {
  const { call, tokens, spreadsheet } = freshWorld();

  const sent = call('chatSend', {
    token: tokens.admin, email: 'sohel@example.com', body: 'Can you take the UPS swap?',
  });
  assert.ok(!sent.error, JSON.stringify(sent.error || {}));
  assert.equal(sent.from, 'amina@example.com');
  assert.equal(sent.to, 'sohel@example.com');
  assert.equal(sent.readAt, null);

  /* It is a row in Messages like anything else, so the sheet is still the whole database. */
  const rows = spreadsheet.getSheetByName('Tracker Messages').rows;
  assert.equal(rows.length, 2, 'a header row and the message');

  const reply = call('chatSend', {
    token: tokens.superuser, email: 'amina@example.com', body: 'Yes, Thursday.',
  });
  assert.ok(!reply.error);

  /* Either of them reads the same conversation, oldest first. */
  for (const [token, other] of [[tokens.admin, 'sohel@example.com'], [tokens.superuser, 'amina@example.com']]) {
    const thread = call('chatWith', { token, email: other });
    assert.deepEqual(thread.messages.map(m => m.body), ['Can you take the UPS swap?', 'Yes, Thursday.']);
  }
});

test('chat: unread counts drop to zero once the conversation is opened', () => {
  const { call, tokens } = freshWorld();
  call('chatSend', { token: tokens.admin, email: 'sohel@example.com', body: 'Ping' });
  call('chatSend', { token: tokens.admin, email: 'sohel@example.com', body: 'Ping again' });

  let contacts = call('chatContacts', { token: tokens.superuser });
  assert.equal(contacts.me.email, 'sohel@example.com');
  assert.equal(contacts.unread, 2);
  assert.equal(contacts.realtime, false, 'there is no socket, so the page is told to poll');

  const amina = contacts.contacts.find(c => c.email === 'amina@example.com');
  assert.equal(amina.unread, 2);
  assert.equal(amina.lastBody, 'Ping again');
  assert.equal(amina.lastFromMe, false);
  /* Whoever spoke last is first in the list. */
  assert.equal(contacts.contacts[0].email, 'amina@example.com');

  assert.equal(call('chatWith', { token: tokens.superuser, email: 'amina@example.com' }).markedRead, 2);
  assert.equal(call('chatContacts', { token: tokens.superuser }).unread, 0);
  /* The sender's own copy was never unread for them. */
  assert.equal(call('chatUnread', { token: tokens.admin }).unread, 0);
});

test('chat: a Viewer may not edit the tracker but can still talk to colleagues', () => {
  const { call, tokens } = freshWorld();
  const sent = call('chatSend', { token: tokens.viewer, email: 'amina@example.com', body: 'Who owns P-1?' });
  assert.ok(!sent.error, 'a viewer can send a message');
  assert.equal(call('chatUnread', { token: tokens.admin }).unread, 1);
});

test('chat: an empty message, a stranger and yourself are all refused', () => {
  const { call, tokens } = freshWorld();
  assert.equal(call('chatSend', { token: tokens.admin, email: 'sohel@example.com', body: '   ' }).error.code, 'empty_message');
  assert.equal(call('chatSend', { token: tokens.admin, email: 'nobody@example.com', body: 'Hello' }).error.code, 'not_found');
  assert.equal(call('chatSend', { token: tokens.admin, email: 'amina@example.com', body: 'Hello' }).error.code, 'self_message');
  const long = call('chatSend', { token: tokens.admin, email: 'sohel@example.com', body: 'x'.repeat(4001) });
  assert.equal(long.error.code, 'too_long');
});

test('chat: signing out is required before chatting', () => {
  const { call } = freshWorld();
  assert.equal(call('chatContacts', {}).error.code, 'unauthorized');
  assert.equal(call('chatSend', { email: 'sohel@example.com', body: 'Hello' }).error.code, 'unauthorized');
});

test('chat: somebody counts as online while they are still polling', () => {
  const { call, tokens, cache } = freshWorld();

  /* Asking for contacts is what the page does every few seconds, so it doubles as a heartbeat. */
  call('chatContacts', { token: tokens.superuser });
  let seen = call('chatContacts', { token: tokens.admin }).contacts.find(c => c.email === 'sohel@example.com');
  assert.equal(seen.online, true);

  /* Ninety seconds without a poll and the cache entry is gone, so they show as away. */
  cache.clear();
  seen = call('chatContacts', { token: tokens.admin }).contacts.find(c => c.email === 'sohel@example.com');
  assert.equal(seen.online, false);
});

test('chat: removing an account takes its conversations with it', () => {
  const { call, tokens } = freshWorld();
  call('chatSend', { token: tokens.admin, email: 'sohel@example.com', body: 'Morning' });
  call('chatSend', { token: tokens.superuser, email: 'vik@example.com', body: 'Morning' });

  call('deleteUser', { token: tokens.superadmin, email: 'sohel@example.com' });

  /* Nothing is left pointing at the account that is gone. */
  assert.equal(call('chatUnread', { token: tokens.viewer }).unread, 0);
  const left = call('chatContacts', { token: tokens.admin }).contacts.map(c => c.email);
  assert.ok(!left.includes('sohel@example.com'));
});

/* ------------------------------------------- LIVING IN SOMEBODY ELSE'S WORKBOOK */

/** Put a few rows in the team's tab the way the team would have: by hand, before the app. */
function workbookWithTeamRows() {
  const world = freshWorld();
  const sheet = world.spreadsheet.getSheetByName('IS Project & Drive');
  /* ID, Type, Impact, FY, Title, Activity, F1, F2, Start, End, Duration, Status, Stakeholder, Budget, Remarks */
  sheet.appendRow(['P-1', 'Project', 'High', '2024', 'MDM', '*PoC closure', 'Mehedi', 'Osman',
    '12-Jun-2024', '30-Jun-2027', 1113, 'Ongoing', 'MF Tech', '', '']);
  sheet.appendRow(['P-2', 'Project', '', '2024', 'AMD laptop PoC', '* PoC successful', 'Mehedi', '',
    '1-Sep-2024', '31-Mar-2025', 211, 'Done', 'MF TECH & OPS', 80000, '']);
  sheet.appendRow(['D-1', 'Drive', 'Mid', '2025', 'Monthly patching', '', 'Rafiqul', '',
    '1-Jan-2025', '', '', 'Ongoing', 'Infrastructure', '', '']);
  return world;
}

test('the team rows already in the workbook are read, not rewritten', () => {
  const { call, tokens, spreadsheet } = workbookWithTeamRows();
  const before = JSON.stringify(spreadsheet.getSheetByName('IS Project & Drive').rows);

  const items = call('listItems', { token: tokens.superadmin }).items;
  assert.deepEqual(items.map(i => i.id), ['P-1', 'P-2', 'D-1']);
  assert.equal(items[0].title, 'MDM');
  assert.equal(items[0].sd, '2024-06-12', 'their date format is understood');
  assert.equal(items[0].pri, 'High', 'Impact is the priority');
  assert.equal(items[2].type, 'Drive');

  assert.equal(JSON.stringify(spreadsheet.getSheetByName('IS Project & Drive').rows), before,
    'reading changed nothing at all');
});

test('a new item is written into the team tab, in the team columns', () => {
  const { call, tokens, spreadsheet } = workbookWithTeamRows();
  const made = call('saveItem', {
    token: tokens.admin,
    item: {
      type: 'Task', title: 'Replace UPS battery', f1: 'Sohel', f2: 'Azmir', s: 'Ongoing',
      pri: 'High', sd: '2026-10-01', e: '2026-10-21', sh: 'Facilities', ms: 'Quote - Done', rm: 'urgent',
    },
  });

  const sheet = spreadsheet.getSheetByName('IS Project & Drive');
  const line = sheet.rows.find(r => r[0] === made.id);
  assert.ok(line, 'the row is in the team tab');
  assert.equal(line[1], 'Drive', 'the Type column has no Task, so a task is filed as a drive');
  assert.equal(line[2], 'High');                       // Impact
  assert.equal(line[4], 'Replace UPS battery');        // Title
  assert.equal(line[5], 'Quote - Done');               // Activity/Milestone
  assert.equal(line[6], 'Sohel');                      // Focal-1
  assert.equal(line[7], 'Azmir');                      // Focal-2
  assert.equal(line[10], 20, 'Duration is worked out for them');
  assert.equal(line[11], 'Ongoing');                   // Status
  assert.equal(line[12], 'Facilities');                // Stakeholder
  assert.equal(line[14], 'urgent');                    // Remarks
  assert.equal(line.length, 15, 'not one column more than they had');

  /* And it reads back as the same day it was given. */
  const back = call('listItems', { token: tokens.admin }).items.find(i => i.id === made.id);
  assert.equal(back.sd, '2026-10-01');
  assert.equal(back.e, '2026-10-21');
});

test('new ids carry on from the numbering already in the sheet', () => {
  const { call, tokens } = workbookWithTeamRows();
  /* P-1 and P-2 are theirs, so the next project must be P-3 and must not land on either. */
  const project = call('saveItem', {
    token: tokens.admin, item: { type: 'Project', title: 'New project', f1: 'Amina' },
  });
  assert.equal(project.id, 'P-3');

  const drive = call('saveItem', {
    token: tokens.admin, item: { type: 'Drive', title: 'New drive', f1: 'Amina' },
  });
  assert.equal(drive.id, 'D-2');

  const ids = call('listItems', { token: tokens.admin }).items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
});

test('editing an item leaves the columns the app does not own alone', () => {
  const { call, tokens, spreadsheet } = workbookWithTeamRows();
  const sheet = spreadsheet.getSheetByName('IS Project & Drive');

  call('saveItem', { token: tokens.admin, id: 'P-2', item: { s: 'Ongoing', rm: 'reopened' } });

  const line = sheet.rows.find(r => r[0] === 'P-2');
  assert.equal(line[11], 'Ongoing', 'the status changed');
  assert.equal(line[14], 'reopened', 'the remark changed');
  assert.equal(line[3], '2024', 'FY is left as they set it');
  assert.equal(line[13], 80000, 'and the budget is never touched');
});

test('a row the app did not create cannot be deleted through the app', () => {
  const { call, tokens, spreadsheet } = workbookWithTeamRows();
  const sheet = spreadsheet.getSheetByName('IS Project & Drive');
  const before = sheet.rows.length;

  const refused = call('deleteItem', { token: tokens.superadmin, id: 'P-1' });
  assert.equal(refused.error.code, 'not_ours');
  assert.match(refused.error.message, /Remove it in the sheet/);
  assert.equal(sheet.rows.length, before, 'their row is still there');

  /* One the app created is its own to remove. */
  const mine = call('saveItem', {
    token: tokens.admin, item: { type: 'Task', title: 'Temporary', f1: 'Amina' },
  });
  assert.equal(sheet.rows.length, before + 1);
  assert.equal(call('deleteItem', { token: tokens.superadmin, id: mine.id }).ok, true);
  assert.equal(sheet.rows.length, before, 'and only that one went');
});

test('the app keeps its own bookkeeping out of the team tab', () => {
  const { call, tokens, spreadsheet } = workbookWithTeamRows();
  call('saveItem', { token: tokens.superuser, item: { type: 'Task', title: 'Mine', f1: 'Sohel' } });

  const sheet = spreadsheet.getSheetByName('IS Project & Drive');
  assert.equal(sheet.getRange(1, 1, 1, 20).getValues()[0].filter(String).length, 15,
    'no column was added to their header row');

  /* Who made it, when, and with which role is recorded in the script's own hidden tab. */
  const meta = spreadsheet.getSheetByName('Tracker Item Meta');
  const row = meta.rows.find(r => r[0] === 'T-1');
  assert.ok(row, 'the bookkeeping row exists');
  assert.equal(row[1], 'Task', 'what the page calls it, which the sheet cannot say');
  assert.equal(row[2], 'superuser');
  assert.equal(row[7], 'yes', 'marked as one of ours');
});

test('a task is filed under the Drive option, because that is all the dropdown allows', () => {
  /* The real tab restricts Type to Drive or Project. Google rejects anything else outright -
     the whole write fails - so a task goes in as a drive, and the page keeps calling it a
     task because the script remembers that itself. */
  const { call, tokens, spreadsheet } = freshWorld();
  const sheet = spreadsheet.getSheetByName('IS Project & Drive');
  sheet.getRange(2, 2).setDataValidationList(['Drive', 'Project']);

  const made = call('saveItem', {
    token: tokens.admin,
    item: { type: 'Task', title: 'Replace UPS battery', f1: 'Sohel', s: 'Ongoing', pri: 'Mid' },
  });
  assert.ok(!made.error, JSON.stringify(made.error || {}));
  assert.equal(made.id, 'T-1', 'the id still says what it is');
  assert.equal(made.type, 'Task', 'and so does the page');

  const line = sheet.rows.find(r => r[0] === 'T-1');
  assert.equal(line[1], 'Drive', 'while the cell holds a value the dropdown accepts');

  const back = call('listItems', { token: tokens.admin }).items.find(i => i.id === 'T-1');
  assert.equal(back.type, 'Task', 'it comes back as a task, not as a drive');
});

test('the words the dropdowns use are the words that get written', () => {
  /* A workbook that says Medium rather than Mid, or On-Going rather than Ongoing, is written
     in its own words instead of having the write refused. */
  const { call, tokens, spreadsheet } = freshWorld();
  const sheet = spreadsheet.getSheetByName('IS Project & Drive');
  sheet.getRange(2, 2).setDataValidationList(['Drive', 'Project']);
  sheet.getRange(2, 3).setDataValidationList(['High', 'Medium', 'Low']);
  sheet.getRange(2, 12).setDataValidationList(['On-Going', 'Done', 'On Hold', 'Listed', 'Closed']);

  const made = call('saveItem', {
    token: tokens.admin,
    item: { type: 'Project', title: 'Core banking upgrade', f1: 'Amina', s: 'Ongoing', pri: 'Mid' },
  });
  assert.ok(!made.error, JSON.stringify(made.error || {}));

  const line = sheet.rows.find(r => r[0] === made.id);
  assert.equal(line[2], 'Medium', 'Mid is written as Medium here');
  assert.equal(line[11], 'On-Going', 'and Ongoing as On-Going');

  /* And both still read back as the page's own words. */
  const back = call('listItems', { token: tokens.admin }).items.find(i => i.id === made.id);
  assert.equal(back.pri, 'Mid');
  assert.equal(back.s, 'Ongoing');
});
