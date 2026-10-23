'use strict';
/* model/team.js – the team roster: who is on the team, with a designation and an email.

   Anyone signed in may read it - it feeds the Team page and the Focal suggestions - but only
   the super admin may change it; the routes enforce that. A member is a row like any other
   record, so it lands in the same storage as everything else. */

const store = require('./store');
const { badRequest, notFound } = require('../view/http');

const normalize = e => String(e || '').trim().toLowerCase();
const idFor = name => 'm_' + (normalize(name).replace(/[^a-z0-9]+/g, '_') || Date.now());

async function list() {
  return (await store.get().all('team')).filter(m => m.name);
}

/** Add or update a member. An id that already exists is updated in place. */
async function save({ id, name, title, email, at, by }) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) throw badRequest('A name is required', 'bad_name');
  const key = String(id || '').trim() || idFor(clean);
  const record = {
    id: key, name: clean,
    title: String(title || '').trim().slice(0, 120),
    email: normalize(email).slice(0, 200),
    at: String(at || '') || store.nowIso().slice(0, 10),
    by: String(by || ''),
  };
  if (await store.get().find('team', { id: key })) await store.get().update('team', { id: key }, record);
  else await store.get().insert('team', record);
  return record;
}

async function remove(id) {
  const gone = await store.get().remove('team', { id: String(id) });
  if (!gone) throw notFound('That person is not on the roster');
  return { id: String(id) };
}

/**
 * Rename somebody wherever they are Focal-1 or Focal-2, matched regardless of case. Returns
 * how many items changed. Items without the name are not touched.
 */
async function rename(from, to, actor) {
  const was = normalize(from), now = String(to || '').trim().slice(0, 120);
  if (!was || !now) throw badRequest('Both the old and the new name are needed', 'bad_name');
  let count = 0;
  for (const row of await store.get().all('items')) {
    const patch = {};
    if (normalize(row.f1) === was) patch.f1 = now;
    if (normalize(row.f2) === was) patch.f2 = now;
    if (!Object.keys(patch).length) continue;
    patch.updatedAt = store.nowIso();
    patch.updatedBy = actor || '';
    await store.get().update('items', { id: row.id }, patch);
    count += 1;
  }
  return { count };
}

module.exports = { list, save, remove, rename };
