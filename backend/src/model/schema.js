'use strict';
/* schema.js – the shape of every table, shared by both storage drivers.

   The same column names are used for SQLite columns and for the header row of each Google Sheet
   tab, so a database can be exported to a sheet, or the other way round, without translation. */

const TABLES = {
  users:    { key: 'email',     columns: ['email', 'name', 'role', 'password', 'externalId', 'createdAt', 'createdBy', 'updatedAt', 'lastLogin'] },
  items:    { key: 'id',        columns: ['id', 'type', 'title', 's', 'pri', 'f1', 'f2', 'sd', 'e', 'sh', 'ms', 'rm', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'role', 'ud'] },
  sessions: { key: 'tokenHash', columns: ['tokenHash', 'email', 'csrf', 'createdAt', 'expiresAt', 'userAgent', 'ip'] },
  requests: { key: 'id',        columns: ['id', 'email', 'name', 'at'] },
  archive:  { key: 'id',        columns: ['id', 'rows', 'at'] },
  resets:   { key: 'email',     columns: ['email', 'codeHash', 'expiresAt', 'attempts', 'createdAt'] },
  messages: { key: 'id',        columns: ['id', 'conversation', 'fromEmail', 'toEmail', 'body', 'at', 'readAt'] },
  meta:     { key: 'key',       columns: ['key', 'value'] },
  audit:    { key: null,        columns: ['at', 'actor', 'role', 'action', 'target', 'detail', 'ip'] },
};

const TABLE_NAMES = Object.keys(TABLES);

/** The tab name used in a Google Sheet, capitalised for readability. */
const sheetName = table => table.charAt(0).toUpperCase() + table.slice(1);

/** Fill in every column, so a row always has the same shape whichever driver produced it. */
function normalizeRow(table, row) {
  const out = {};
  for (const column of TABLES[table].columns) {
    const value = row ? row[column] : undefined;
    out[column] = value === undefined || value === null ? '' : value;
  }
  return out;
}

module.exports = { TABLES, TABLE_NAMES, sheetName, normalizeRow };
