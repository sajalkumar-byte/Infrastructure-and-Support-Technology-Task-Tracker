'use strict';
/* team.test.js – the team roster: who is on the team, kept by the super admin alone. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

function world() {
  const w = load();
  w.sandbox.setupTracker();
  const boss = w.call('login', { email: 'admin@tracker.com', password: 'Admin@1234' });
  const tokens = { superadmin: boss.token };
  for (const a of [
    { email: 'amina@example.com', name: 'Amina', role: 'admin', password: 'adminpw' },
    { email: 'vik@example.com', name: 'Vik', role: 'viewer', password: 'viewerpw' },
  ]) {
    w.call('createUser', { ...a, token: boss.token });
    tokens[a.role] = w.call('login', { email: a.email, password: a.password }).token;
  }
  return { ...w, tokens };
}

test('the super admin adds, edits and removes team members; the roster is kept in its own hidden tab', () => {
  const { call, tokens, spreadsheet } = world();

  const added = call('saveTeam', { token: tokens.superadmin, name: 'Mosiar Rahman', title: 'Senior Officer, IS', email: 'Mosiar@brac.net' });
  assert.ok(!added.error, JSON.stringify(added.error || {}));
  assert.equal(added.id, 'm_mosiar_rahman');
  assert.equal(added.email, 'mosiar@brac.net', 'email is normalised');

  let roster = call('listTeam', { token: tokens.viewer }).members;
  assert.equal(roster.length, 1, 'anyone signed in may read the roster');
  assert.equal(roster[0].title, 'Senior Officer, IS');

  const edited = call('saveTeam', { token: tokens.superadmin, id: added.id, name: 'Mosiar Rahman', title: 'Lead, IS', email: 'mosiar@brac.net' });
  assert.equal(edited.title, 'Lead, IS');
  assert.equal(call('listTeam', { token: tokens.viewer }).members.length, 1, 'an edit does not add a second row');

  const tab = spreadsheet.getSheetByName('Tracker Team');
  assert.ok(tab && tab.hidden, 'the roster lives in a hidden tab of its own');
  assert.equal(tab.rows.length, 2, 'header and one member');

  assert.equal(call('deleteTeam', { token: tokens.superadmin, id: added.id }).ok, true);
  assert.equal(call('listTeam', { token: tokens.viewer }).members.length, 0);
  assert.equal(call('deleteTeam', { token: tokens.superadmin, id: added.id }).error.code, 'not_found');
});

test('nobody but the super admin may change the roster', () => {
  const { call, tokens } = world();
  for (const who of ['admin', 'viewer']) {
    assert.equal(call('saveTeam', { token: tokens[who], name: 'Intruder' }).error.code, 'forbidden', who + ' cannot add');
    assert.equal(call('deleteTeam', { token: tokens[who], id: 'm_x' }).error.code, 'forbidden', who + ' cannot remove');
    assert.equal(call('renamePerson', { token: tokens[who], from: 'A', to: 'B' }).error.code, 'forbidden', who + ' cannot rename');
  }
  assert.equal(call('saveTeam', { token: tokens.superadmin, name: '   ' }).error.code, 'bad_name');
});

test('renaming a person renames them on every item they are on, and nowhere else', () => {
  const { call, tokens, spreadsheet } = world();
  const mk = (type, title, f1, f2) => call('saveItem', { token: tokens.admin, item: { type, title, f1, f2, s: 'Ongoing', pri: 'Mid' } });
  mk('Project', 'Core banking', 'Mosiar', 'Sarwar');
  mk('Task', 'UPS battery', 'Sarwar', 'Mosiar');
  mk('Task', 'SSL renewal', 'Azmir', '');

  const done = call('renamePerson', { token: tokens.superadmin, from: 'mosiar', to: 'Md. Mosiar Rahman' });
  assert.ok(!done.error, JSON.stringify(done.error || {}));
  assert.equal(done.count, 2, 'two items carried the name, matched regardless of case');

  const items = call('listItems', { token: tokens.admin }).items;
  const byTitle = t => items.find(i => i.title === t);
  assert.equal(byTitle('Core banking').f1, 'Md. Mosiar Rahman');
  assert.equal(byTitle('Core banking').f2, 'Sarwar', 'the other focal is untouched');
  assert.equal(byTitle('UPS battery').f2, 'Md. Mosiar Rahman');
  assert.equal(byTitle('SSL renewal').f1, 'Azmir', 'an item without the name is untouched');

  /* It reached the team's own tabs, in their columns. */
  const projects = spreadsheet.getSheetByName('IS Project & Drive');
  assert.equal(projects.rows.find(r => r[4] === 'Core banking')[6], 'Md. Mosiar Rahman', 'Focal-1 in the projects tab');
  const tasks = spreadsheet.getSheetByName('Individual Task List');
  assert.equal(tasks.rows.find(r => r[5] === 'UPS battery')[13], 'Md. Mosiar Rahman', 'Focal-2 in the tasks tab');
});
