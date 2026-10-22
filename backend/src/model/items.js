'use strict';
/* repos/items.js – projects, recurring items and tasks.

   The field names match what the browser already uses, so no screen had to change:
     id, type, title, s (status), pri, f1 (Focal-1), f2, sd (start), e (end),
     sh (stakeholder), ms (milestones), rm (remarks)
   The server adds createdAt/By and updatedAt/By. */

const store = require('./store');
const { TYPES } = require('./permissions');
const { badRequest, notFound } = require('../view/http');

const STATUSES = ['Ongoing', 'On Hold', 'Listed', 'Closed', 'Done'];
const PRIORITIES = ['High', 'Mid', 'Low'];
const PREFIX = { Project: 'P', Drive: 'D', Task: 'T' };
const FIELDS = ['id', 'type', 'title', 's', 'pri', 'f1', 'f2', 'sd', 'e', 'sh', 'ms', 'rm'];

const str = (v, max = 2000) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
const isDate = v => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v);
const num = id => {
  const n = parseInt(String(id).slice(2), 10);
  return Number.isNaN(n) ? 0 : n;
};

function toClient(row) {
  if (!row) return null;
  return {
    id: row.id, type: row.type, title: row.title, s: row.s, pri: row.pri,
    f1: row.f1, f2: row.f2, sd: row.sd, e: row.e, sh: row.sh, ms: row.ms, rm: row.rm,
    createdAt: row.createdAt, createdBy: row.createdBy,
    updatedAt: row.updatedAt, updatedBy: row.updatedBy, role: row.role || '', ud: row.ud || '',
  };
}

async function list(filter = {}) {
  let rows = await store.get().all('items');
  if (filter.type) rows = rows.filter(r => r.type === filter.type);
  if (filter.status) rows = rows.filter(r => r.s === filter.status);
  if (filter.person) {
    const needle = String(filter.person).toLowerCase();
    rows = rows.filter(r => String(r.f1).toLowerCase().includes(needle) || String(r.f2).toLowerCase().includes(needle));
  }
  if (filter.q) {
    const needle = String(filter.q).toLowerCase();
    rows = rows.filter(r => `${r.title} ${r.id} ${r.sh} ${r.ms}`.toLowerCase().includes(needle));
  }
  return rows
    .sort((a, b) => String(a.type).localeCompare(String(b.type)) || num(a.id) - num(b.id))
    .map(toClient);
}

async function byId(id) {
  return toClient(await store.get().find('items', { id: String(id) }));
}

/**
 * Next free id for a type: P-1, P-2, D-1, T-1 … matching the browser's numbering.
 * The highest number ever handed out is remembered, so deleting an item does not free its id
 * for reuse. Two reports printed on different days can never disagree about what P-1 was.
 */
async function nextId(type, rows) {
  const all = rows || await store.get().all('items');
  const prefix = `${PREFIX[type]}-`;
  const inUse = all.reduce((best, r) => {
    const id = String(r.id || '');
    return id.startsWith(prefix) ? Math.max(best, num(id)) : best;
  }, 0);

  const key = `lastId:${type}`;
  const marker = await store.get().find('meta', { key });
  const everUsed = marker ? Number(marker.value) || 0 : 0;

  const next = Math.max(inUse, everUsed) + 1;
  if (marker) await store.get().update('meta', { key }, { value: String(next) });
  else await store.get().insert('meta', { key, value: String(next) });
  return `${prefix}${next}`;
}

/** Validate and normalise an incoming item. Unknown fields are dropped. */
function clean(input = {}, { partial = false } = {}) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(input, k);

  if (!partial || has('type')) {
    const type = str(input.type, 20);
    if (!TYPES.includes(type)) throw badRequest(`Type must be one of: ${TYPES.join(', ')}`, 'bad_type');
    out.type = type;
  }
  if (!partial || has('title')) {
    const title = str(input.title, 300);
    if (!title) throw badRequest('A name or title is required', 'bad_title');
    out.title = title;
  }
  if (!partial || has('f1')) {
    const f1 = str(input.f1, 120);
    if (!f1) throw badRequest('Focal-1 (lead) is required', 'bad_focal');
    out.f1 = f1;
  }
  if (!partial || has('s')) {
    const s = str(input.s, 20) || 'Ongoing';
    if (!STATUSES.includes(s)) throw badRequest(`Status must be one of: ${STATUSES.join(', ')}`, 'bad_status');
    out.s = s;
  }
  if (!partial || has('pri')) {
    const pri = str(input.pri, 10) || 'Mid';
    if (!PRIORITIES.includes(pri)) throw badRequest(`Priority must be one of: ${PRIORITIES.join(', ')}`, 'bad_priority');
    out.pri = pri;
  }
  for (const [key, max] of [['f2', 120], ['sh', 200], ['rm', 2000], ['ms', 8000]]) {
    if (!partial || has(key)) out[key] = str(input[key], max);
  }
  for (const key of ['sd', 'e', 'ud']) {
    if (!partial || has(key)) {
      const v = str(input[key], 10);
      if (!isDate(v)) throw badRequest(`${key === 'sd' ? 'Start' : 'End'} date must look like 2026-10-15`, 'bad_date');
      out[key] = v;
    }
  }
  return out;
}

async function create(input, actor, role) {
  const data = clean(input);
  const existing = await store.get().all('items');
  const wanted = String(input.id || '');
  const id = /^[PDT]-\d+$/.test(wanted) && !existing.some(r => r.id === wanted)
    ? wanted
    : await nextId(data.type, existing);

  await store.get().insert('items', {
    /* The role it was created with, so a spreadsheet can show each role its own work. It comes
       from the session, never from the request, and an edit never rewrites it. */
    ...data, id, createdAt: store.nowIso(), createdBy: actor || '', updatedAt: '', updatedBy: '',
    role: role || '',
  });
  return byId(id);
}

async function update(id, patch, actor) {
  const current = await byId(id);
  if (!current) throw notFound('That item no longer exists');
  const data = clean(patch, { partial: true });
  delete data.type;                      // an item never changes type once created
  if (!Object.keys(data).length) return current;
  data.updatedAt = store.nowIso();
  data.updatedBy = actor || '';
  await store.get().update('items', { id: current.id }, data);
  return byId(current.id);
}

async function remove(id) {
  const current = await byId(id);
  if (!current) throw notFound('That item no longer exists');
  await store.get().remove('items', { id: current.id });
  return current;
}

/** Replace an item wholesale (the browser's `set`). Creates it when the id is unknown. */
async function put(id, input, actor) {
  const existing = await byId(id);
  if (!existing) return create({ ...input, id }, actor);
  return update(id, { ...input, type: undefined }, actor);
}

/* ---- archive ("taskhist" in the browser): batches of older rows, kept read-only ---- */
async function listArchive() {
  const rows = await store.get().all('archive');
  return rows.map(b => {
    let parsed = [];
    try { parsed = JSON.parse(b.rows || '[]'); } catch { parsed = []; }
    return { id: b.id, rows: Array.isArray(parsed) ? parsed : [], at: b.at };
  });
}

async function putArchive(id, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const record = { id: String(id), rows: JSON.stringify(list), at: store.nowIso() };
  const existing = await store.get().find('archive', { id: record.id });
  if (existing) await store.get().update('archive', { id: record.id }, record);
  else await store.get().insert('archive', record);
  return { id: record.id, rows: list };
}

async function removeArchive(id) {
  await store.get().remove('archive', { id: String(id) });
  return { id: String(id) };
}

/** Counts per type and status, behind the dashboard and the exports. */
async function stats() {
  const rows = await store.get().all('items');
  const byType = {};
  for (const t of TYPES) {
    byType[t] = { total: 0 };
    for (const s of STATUSES) byType[t][s] = 0;
  }
  const today = new Date().toISOString().slice(0, 10);
  let overdue = 0;
  for (const r of rows) {
    if (!byType[r.type]) continue;
    if (byType[r.type][r.s] !== undefined) byType[r.type][r.s] += 1;
    byType[r.type].total += 1;
    if (r.s === 'Ongoing' && r.e && String(r.e) < today) overdue += 1;
  }
  return { total: rows.length, overdue, byType, generatedAt: store.nowIso() };
}

module.exports = {
  STATUSES, PRIORITIES, TYPES, FIELDS,
  list, byId, nextId, clean, create, update, remove, put,
  listArchive, putArchive, removeArchive, stats, toClient,
};
