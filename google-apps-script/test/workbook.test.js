'use strict';
/* workbook.test.js – the tracker as a guest in the team's own workbook.

   The projects tab and the tasks tab already exist, with the team's columns and the team's
   rows. These tests pin the promises that follow from that: each kind of item lands in its
   own tab, in that tab's words; nothing that was already there is overwritten or deleted; a
   create can never land on an existing id; and bookkeeping trouble never undoes a save. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const PROJECTS = 'IS Project & Drive';
const TASKS = 'Individual Task List';

/** A fresh spreadsheet, a super admin, and one account per role. */
function freshWorld() {
  const world = load();
  world.sandbox.setupTracker();
  const boss = world.call('login', { email: 'admin@tracker.com', password: 'Admin@1234' });
  const tokens = { superadmin: boss.token };
  for (const a of [
    { email: 'amina@example.com', name: 'Amina', role: 'admin', password: 'adminpw' },
    { email: 'sohel@example.com', name: 'Sohel', role: 'superuser', password: 'superpw' },
  ]) {
    world.call('createUser', { ...a, token: boss.token });
    tokens[a.role] = world.call('login', { email: a.email, password: a.password }).token;
  }
  return { ...world, tokens };
}

/** Rows the team would have typed by hand, before the app ever ran. */
function workbook() {
  const world = freshWorld();
  const projects = world.spreadsheet.getSheetByName(PROJECTS);
  /* ID, Type, Impact, FY, Title, Activity, F1, F2, Start, End, Duration, Status, Stakeholder, Budget, Remarks */
  projects.appendRow(['P-1', 'Project', 'High', '2024', 'MDM', '*PoC closure', 'Mehedi', 'Osman',
    '12-Jun-2024', '30-Jun-2027', 1113, 'Ongoing', 'MF Tech', '', '']);
  projects.appendRow(['P-2', 'Project', '', '2024', 'AMD laptop PoC', '* PoC successful', 'Mehedi', '',
    '1-Sep-2024', '31-Mar-2025', 211, 'Done', 'MF TECH & OPS', 80000, '']);
  projects.appendRow(['D-1', 'Drive', 'Mid', '2025', 'Monthly patching', '', 'Rafiqul', '',
    '1-Jan-2025', '', '', 'Ongoing', 'Infrastructure', '', '']);

  const tasks = world.spreadsheet.getSheetByName(TASKS);
  /* SN, Ref. ID, Assigned to, Priority, FY, Task Title, Milestones, Start, End, Duration, Status, Requester, Vendor, Focal-2, Remarks */
  tasks.appendRow([1, '', 'Ananna', 'Medium', '15-May-2024', 'Procurement Dashboard', 'Task list, documentation running',
    '1-Dec-2024', '30-Dec-2025', 394, 'Done', '', '', 'Kawsar', '']);
  tasks.appendRow([2, '', 'Ananna', 'Medium', '2-Jul-2025', 'MF Laptop book value write off', 'Most issues solved',
    '12-Jan-2025', '30-Nov-2025', 322, 'Done', '', '', '', '']);
  tasks.appendRow([3, '', 'Sarwar', 'High', '', 'PMS assessment of 13 TOs', '* Book timeslot',
    '14-Oct-2025', '21-Oct-2025', 7, 'Ongoing', 'HR', 'none', '', '']);
  return world;
}

/* ------------------------------------------------------------ tasks in their own tab */

test('the tasks tab is read as tasks, alongside the projects and drives', () => {
  const { call, tokens } = workbook();
  const items = call('listItems', { token: tokens.superadmin }).items;

  assert.deepEqual(items.map(i => i.id), ['P-1', 'P-2', 'D-1', 'T-1', 'T-2', 'T-3']);
  const t1 = items.find(i => i.id === 'T-1');
  assert.equal(t1.type, 'Task');
  assert.equal(t1.title, 'Procurement Dashboard');
  assert.equal(t1.f1, 'Ananna', 'Assigned to is Focal-1');
  assert.equal(t1.f2, 'Kawsar');
  assert.equal(t1.pri, 'Mid', 'Medium reads as Mid');
  assert.equal(t1.sd, '2024-12-01');
  assert.equal(t1.e, '2025-12-30');
  assert.equal(t1.s, 'Done');
  assert.equal(items.find(i => i.id === 'T-3').sh, 'HR', 'Requester is the stakeholder');
  assert.equal(items.find(i => i.id === 'D-1').type, 'Task',
    'the workbook has no recurring items, so a row marked Drive is listed with the tasks');
});

test('a new task is written into the tasks tab, in its columns, carrying on the serial', () => {
  const { call, tokens, spreadsheet } = workbook();
  const made = call('saveItem', {
    token: tokens.superuser,
    item: { type: 'Task', title: 'Replace UPS battery', f1: 'Sohel', f2: 'Azmir', s: 'Ongoing',
      pri: 'High', sd: '2026-10-22', e: '2026-10-31', sh: 'Facilities', ms: 'Quote - Done', rm: 'urgent' },
  });
  assert.ok(!made.error, JSON.stringify(made.error || {}));
  assert.equal(made.id, 'T-4', 'the next serial after 3');

  const line = spreadsheet.getSheetByName(TASKS).rows.find(r => r[1] === 'T-4');
  assert.ok(line, 'the row is in the tasks tab');
  assert.equal(line[0], 4, 'SN');
  assert.equal(line[2], 'Sohel', 'Assigned to');
  assert.equal(line[3], 'High');
  assert.equal(line[5], 'Replace UPS battery');
  assert.equal(line[6], 'Quote - Done');
  assert.equal(line[9], 9, 'Duration');
  assert.equal(line[10], 'Ongoing');
  assert.equal(line[11], 'Facilities', 'Requester');
  assert.equal(line[13], 'Azmir', 'Focal-2');
  assert.equal(line[14], 'urgent');
  assert.equal(line.length, 15, 'not one column more than they had');

  assert.ok(!spreadsheet.getSheetByName(PROJECTS).rows.some(r => r[0] === 'T-4'),
    'nothing landed in the projects tab');
});

test('editing a task writes back to the tasks tab and leaves Vendor alone', () => {
  const { call, tokens, spreadsheet } = workbook();
  const edited = call('saveItem', { token: tokens.superuser, id: 'T-3', item: { s: 'Done', rm: 'closed out' } });
  assert.ok(!edited.error, JSON.stringify(edited.error || {}));

  const line = spreadsheet.getSheetByName(TASKS).rows.find(r => r[0] === 3);
  assert.equal(line[10], 'Done');
  assert.equal(line[14], 'closed out');
  assert.equal(line[12], 'none', 'Vendor is not the app to change');
  /* T-3 had no FY, so it is filled from the start date; T-1 has one, and it must survive. */
  assert.equal(line[4], '2025', 'an empty FY is filled from the start date');
  call('saveItem', { token: tokens.superuser, id: 'T-1', item: { rm: 'touched' } });
  assert.equal(spreadsheet.getSheetByName(TASKS).rows.find(r => r[0] === 1)[4], '15-May-2024',
    'a year somebody chose is never overruled');
});

test('a task the team typed cannot be deleted through the app; one the app made can', () => {
  const { call, tokens, spreadsheet } = workbook();
  const tasks = spreadsheet.getSheetByName(TASKS);
  const before = tasks.rows.length;

  assert.equal(call('deleteItem', { token: tokens.superadmin, id: 'T-2' }).error.code, 'not_ours');
  assert.equal(tasks.rows.length, before);

  const mine = call('saveItem', { token: tokens.superuser, item: { type: 'Task', title: 'Temporary', f1: 'Sohel' } });
  assert.equal(tasks.rows.length, before + 1);
  assert.equal(call('deleteItem', { token: tokens.superadmin, id: mine.id }).ok, true);
  assert.equal(tasks.rows.length, before);
});

test('a team row marked Drive is a task by default, a drive when asked, and never changes an item the page made', () => {
  const { call, tokens, properties, spreadsheet } = workbook();
  const find = id => call('listItems', { token: tokens.superadmin }).items.find(i => i.id === id);
  assert.equal(find('D-1').type, 'Task');

  properties.set('DRIVE_ROWS_SHOW_AS', 'Drive');
  assert.equal(find('D-1').type, 'Drive');
  properties.delete('DRIVE_ROWS_SHOW_AS');

  /* One the page created as recurring stays recurring whatever the setting says: the page's
     own record of what it made wins over the one word the cell can hold. */
  const mine = call('saveItem', {
    token: tokens.admin,
    item: { type: 'Drive', title: 'Monthly backup test', f1: 'Amina', sd: '2026-10-01', ud: '2026-10-22' },
  });
  assert.ok(!mine.error, JSON.stringify(mine.error || {}));
  assert.equal(find(mine.id).type, 'Drive');
  assert.equal(spreadsheet.getSheetByName(PROJECTS).rows.find(r => r[0] === mine.id)[1], 'Recurring',
    'and in the sheet it says Recurring, in so many words');
});

test('a recurring item is sent as "Recurring", and the dropdown is taught the word once', () => {
  const { call, tokens, spreadsheet } = workbook();
  const projects = spreadsheet.getSheetByName(PROJECTS);
  projects.getRange(2, 2).setDataValidationList(['Drive', 'Project']);

  const made = call('saveItem', {
    token: tokens.admin,
    item: { type: 'Drive', title: 'Monthly backup test', f1: 'Amina', sd: '2026-10-01', ud: '2026-10-23' },
  });
  assert.ok(!made.error, JSON.stringify(made.error || {}));

  const line = projects.rows.find(r => r[0] === made.id);
  assert.equal(line[1], 'Recurring', 'the cell says Recurring');
  assert.deepEqual(projects.validations[1], ['Drive', 'Project', 'Recurring'],
    'the dropdown gained the word and lost nothing');

  /* Read back as recurring even with the bookkeeping gone: the word in the cell is enough. */
  const meta = spreadsheet.getSheetByName('Tracker Item Meta');
  meta.rows.splice(meta.rows.findIndex(r => r[0] === made.id), 1);
  const back = call('listItems', { token: tokens.admin }).items.find(i => i.id === made.id);
  assert.equal(back.type, 'Drive', 'Recurring in the cell reads as recurring');

  /* The team's own "Drive" rows are still their tasks. */
  assert.equal(call('listItems', { token: tokens.admin }).items.find(i => i.id === 'D-1').type, 'Task');

  /* A second recurring item does not touch the dropdown again. */
  call('saveItem', { token: tokens.admin, item: { type: 'Drive', title: 'Weekly patching', f1: 'Amina' } });
  assert.deepEqual(projects.validations[1], ['Drive', 'Project', 'Recurring']);
});

test('a recurring item has a start date and an update date, and no end date anywhere', () => {
  const { call, tokens, spreadsheet } = workbook();
  const made = call('saveItem', {
    token: tokens.admin,
    item: { type: 'Drive', title: 'Weekly patching', f1: 'Amina', sd: '2026-10-01', e: '2026-12-31', ud: '2026-10-22' },
  });
  assert.ok(!made.error, JSON.stringify(made.error || {}));
  assert.equal(made.ud, '2026-10-22');
  assert.equal(made.e, '', 'an end date sent for a recurring item is dropped');

  const line = spreadsheet.getSheetByName(PROJECTS).rows.find(r => r[0] === made.id);
  assert.equal(line[8] instanceof Date || String(line[8]).length > 0, true, 'Start Date is written');
  assert.equal(line[9], '', 'End Date stays empty');
  assert.equal(line[10], '', 'and so does Duration');

  const back = call('listItems', { token: tokens.admin }).items.find(i => i.id === made.id);
  assert.equal(back.ud, '2026-10-22', 'the update date comes back');
  assert.equal(back.e, '');
});

/* ------------------------------------------------------------- not reading it all again */

test('a page that asks with the last change counter is told when nothing changed', () => {
  const { call, tokens } = workbook();
  const first = call('listItems', { token: tokens.admin });
  assert.ok(Array.isArray(first.items));

  /* Nothing written yet, so there is no counter and a full answer is the only honest one. */
  const again = call('listItems', { token: tokens.admin, rev: first.rev });
  assert.ok(Array.isArray(again.items), 'no counter yet means a full read');

  call('saveItem', { token: tokens.admin, item: { type: 'Project', title: 'Bump', f1: 'Amina' } });
  const after = call('listItems', { token: tokens.admin });
  assert.ok(after.rev, 'a write starts the counter');
  assert.ok(after.items.some(i => i.title === 'Bump'));

  const quick = call('listItems', { token: tokens.admin, rev: after.rev });
  assert.equal(quick.unchanged, true, 'the same counter means nothing to read');
  assert.equal(quick.rev, after.rev);

  call('saveItem', { token: tokens.admin, id: after.items.find(i => i.title === 'Bump').id, item: { s: 'Done' } });
  const changed = call('listItems', { token: tokens.admin, rev: after.rev });
  assert.ok(Array.isArray(changed.items), 'a write since means a full read');
  assert.notEqual(changed.rev, after.rev);
});

test('within one request each tab is read once, however many times it is asked for', () => {
  const { call, tokens, spreadsheet } = workbook();
  const meta = spreadsheet.getSheetByName('Tracker Item Meta');
  const tasks = spreadsheet.getSheetByName(TASKS);
  let reads = 0;
  const count = sheet => { const real = sheet.getRange.bind(sheet); sheet.getRange = (...a) => { reads += 1; return real(...a); }; };
  count(meta); count(tasks);

  reads = 0;
  call('saveItem', { token: tokens.admin, item: { type: 'Task', title: 'One read', f1: 'Amina', s: 'Ongoing', pri: 'Mid' } });
  /* Listing items, giving out the id, writing the row and the note about it: a handful of
     range calls, not dozens. Sampling a date column used to be one call per cell. */
  assert.ok(reads < 25, 'a save touched the sheets ' + reads + ' times');
});

/* --------------------------------------------------------- a create is never an overwrite */

test('a new item never lands on an existing id, whatever the page guessed', () => {
  const { call, tokens, spreadsheet } = workbook();
  const before = spreadsheet.getSheetByName(PROJECTS).rows.find(r => r[0] === 'P-2').slice();

  /* The page used to send the id it had worked out; here that id already belongs to a row. */
  const made = call('saveItem', {
    token: tokens.admin,
    item: { id: 'P-2', type: 'Project', title: 'Something new', f1: 'Amina' },
  });
  assert.ok(!made.error, JSON.stringify(made.error || {}));
  assert.equal(made.id, 'P-3', 'it is given the next free id instead');
  assert.deepEqual(spreadsheet.getSheetByName(PROJECTS).rows.find(r => r[0] === 'P-2'), before,
    'and P-2 is exactly as it was');
});

test('editing an id that is gone is refused rather than recreated', () => {
  const { call, tokens } = workbook();
  const res = call('saveItem', { token: tokens.admin, id: 'P-99', item: { title: 'Ghost' } });
  assert.equal(res.error.code, 'not_found');
});

test('a save still succeeds when only the bookkeeping fails', () => {
  /* The row is in the team's tab by the time the note about it is written. If that note
     cannot be written, saying the save failed would be untrue - and it is exactly how
     "error shown, but the data is in the sheet" happens. */
  const { call, tokens, spreadsheet } = workbook();
  const meta = spreadsheet.getSheetByName('Tracker Item Meta');
  const realAppend = meta.appendRow.bind(meta);
  let blocked = 0;
  meta.appendRow = () => { blocked += 1; throw new Error('quota'); };

  const made = call('saveItem', { token: tokens.admin, item: { type: 'Project', title: 'Survives', f1: 'Amina' } });
  assert.ok(!made.error, 'the save is reported as what it was: done');
  assert.ok(blocked >= 1, 'the bookkeeping was attempted');
  assert.ok(spreadsheet.getSheetByName(PROJECTS).rows.some(r => r[4] === 'Survives'));
  meta.appendRow = realAppend;
});

test('a meta tab laid out by an older version is read correctly and brought up to date', () => {
  /* The older layout had no "type" column: id, role, createdAt, createdBy, updatedAt,
     updatedBy, owned. Read by position, every value would sit one column off. */
  const { call, sandbox, spreadsheet } = load();
  const old = spreadsheet.insertSheet('Tracker Item Meta');
  old.getRange(1, 1, 1, 7).setValues([['id', 'role', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'owned']]);
  old.appendRow(['P-1', 'admin', '2026-10-19T11:01:14.055Z', 'amina@example.com', '', '', 'yes']);
  sandbox.setupTracker();
  spreadsheet.getSheetByName(PROJECTS)
    .appendRow(['P-1', 'Project', 'High', '2024', 'MDM', '', 'Mehedi', '', '12-Jun-2024', '', '', 'Ongoing', '', '', '']);

  const boss = call('login', { email: 'admin@tracker.com', password: 'Admin@1234' }).token;
  const p1 = call('listItems', { token: boss }).items.find(i => i.id === 'P-1');
  assert.equal(p1.role, 'admin', 'the role is the role, not a timestamp');
  assert.equal(p1.createdBy, 'amina@example.com');

  const header = spreadsheet.getSheetByName('Tracker Item Meta').getRange(1, 1, 1, 8).getValues()[0];
  assert.deepEqual(header, ['id', 'type', 'role', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'owned']);
});
