'use strict';
/* harness.js – runs Code.gs inside Node by standing in for the Google Apps Script services.
   It lets the Google Sheets backend be tested properly before it is deployed: the spreadsheet is
   an array in memory, but the code under test is the real file, unmodified. */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const CODE = path.resolve(__dirname, '..', 'Code.gs');

/* The fake spreadsheet sits east of Greenwich, like the real one, because that is what makes a
   date written as text come back as the previous evening. Six hours is Asia/Dhaka. */
const TZ_OFFSET_HOURS = 6;
const FAKE_TIME_ZONE = 'Asia/Dhaka';
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** Sheets stores a typed date as a date, not as the text that was typed – unless the cell is
    formatted as plain text. Reproducing that here is what keeps the backend honest about it. */
function asSheetsWouldStore(value, format) {
  if (format === '@') return value;
  if (typeof value === 'string' && DAY_TEXT.test(value)) {
    return new Date(Date.parse(value + 'T00:00:00Z') - TZ_OFFSET_HOURS * 3600 * 1000);
  }
  return value;
}

/* ---------- a spreadsheet made of arrays ---------- */
class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValue() { return this.getValues()[0][0]; }
  /* A dropdown on a column, the way the real tab has one on Type. */
  getDataValidation() {
    const list = this.sheet.validations[this.col - 1];
    if (!list) return null;
    return {
      getCriteriaType: () => 'VALUE_IN_LIST',
      getCriteriaValues: () => [list.slice()],
    };
  }
  setDataValidationList(values) { this.sheet.validations[this.col - 1] = values.slice(); return this; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = this.sheet.rows[this.row - 1 + r] || [];
      const cells = [];
      for (let c = 0; c < this.numCols; c++) cells.push(line[this.col - 1 + c] ?? '');
      out.push(cells);
    }
    return out;
  }
  setValues(values) {
    values.forEach((line, r) => {
      const target = this.row - 1 + r;
      while (this.sheet.rows.length <= target) this.sheet.rows.push([]);
      line.forEach((v, c) => {
        const column = this.col - 1 + c;
        const list = this.sheet.validations[column];
        if (list && target > 0 && String(v || '') && list.indexOf(String(v)) === -1) {
          throw new Error('The data you entered in cell '
            + String.fromCharCode(65 + column) + (target + 1)
            + ' violates the data validation rules set on this cell. Please enter one of the '
            + 'following values: ' + list.join(', ') + '.');
        }
        this.sheet.rows[target][column] = asSheetsWouldStore(v, this.sheet.formats[column]);
        /* Typing a value over a formula removes the formula, here as in Sheets. */
        delete this.sheet.formulas[target + ',' + column];
      });
    });
    return this;
  }
  setNumberFormat(format) {
    for (let c = 0; c < this.numCols; c++) this.sheet.formats[this.col - 1 + c] = format;
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      const line = this.sheet.rows[this.row - 1 + r];
      if (!line) continue;
      for (let c = 0; c < this.numCols; c++) line[this.col - 1 + c] = '';
    }
    return this;
  }
  setFontWeight() { return this; }
  /* Formulas are not evaluated here: a test can read back what a view tab was told to show,
     which is the part this code is responsible for. Google does the arithmetic. */
  setFormula(formula) {
    while (this.sheet.rows.length < this.row) this.sheet.rows.push([]);
    this.sheet.rows[this.row - 1][this.col - 1] = formula;
    this.sheet.formulas[(this.row - 1) + ',' + (this.col - 1)] = formula;
    return this;
  }
  getFormula() { return this.sheet.formulas[(this.row - 1) + ',' + (this.col - 1)] || ''; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.formats = []; this.formulas = {}; this.validations = []; }
  getMaxRows() { return Math.max(this.rows.length, 1000); }
  getLastColumn() {
    let width = 0;
    for (const line of this.rows) {
      for (let c = 0; c < (line || []).length; c++) if (String(line[c] ?? '').length) width = Math.max(width, c + 1);
    }
    return width;
  }
  clear() { this.rows = []; this.formats = []; this.formulas = {}; return this; }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if ((this.rows[i] || []).some(v => String(v ?? '').length)) return i + 1;
    }
    return 0;
  }
  /* Apps Script lets the last two go, meaning a single cell; the stub has to as well. */
  getRange(row, col, numRows, numCols) {
    return new FakeRange(this, row, col, numRows === undefined ? 1 : numRows,
      numCols === undefined ? 1 : numCols);
  }
  appendRow(values) {
    /* A value appended to a column formatted as plain text stays text, as in Sheets. */
    this.rows[this.getLastRow()] = values.map((v, c) => asSheetsWouldStore(v, this.formats[c]));
  }
  deleteRow(index) { this.rows.splice(index - 1, 1); }
  setFrozenRows() { return this; }
  hideSheet() { this.hidden = true; return this; }
  getName() { return this.name; }
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.set(name, s); return s; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake'; }
  getSpreadsheetTimeZone() { return FAKE_TIME_ZONE; }
  getSheets() { return [...this.sheets.values()]; }
}

/* ---------- load Code.gs with the Apps Script services replaced ---------- */
function load({ logs = [], outbox = [] } = {}) {
  const spreadsheet = new FakeSpreadsheet();

  /* The workbook the script is a guest in. The team's own tab exists before the script runs,
     with their fifteen headings and their column order - that is the whole situation the
     adapter has to cope with, so the tests start from it rather than from an empty file. */
  const TEAM_TAB = 'IS Project & Drive';
  const TEAM_HEADERS = ['ID', 'Type', 'Impact', 'FY', 'Title (with Link)', 'Activity/Milestone',
    'Focal-1', 'Focal-2', 'Start Date', 'End Date', 'Duration', 'Status', 'Stakeholder',
    'Budget (If any)', 'Remarks'];
  spreadsheet.insertSheet(TEAM_TAB).getRange(1, 1, 1, TEAM_HEADERS.length).setValues([TEAM_HEADERS]);
  /* And the tasks tab, with its own fifteen headings. */
  const TASK_TAB = 'Individual Task List';
  const TASK_HEADERS = ['SN', 'Ref. ID', 'Assigned to', 'Priority', 'FY', 'Task Title',
    'Mile stones : Current Status', 'Starting Date', 'End Date', 'Duration  (C.Days)', 'Status',
    'Requester  (Unit/Client)', 'Vendor', 'Focal-2', 'Remarks / Note'];
  spreadsheet.insertSheet(TASK_TAB).getRange(1, 1, 1, TASK_HEADERS.length).setValues([TASK_HEADERS]);
  const properties = new Map();
  const cache = new Map();            // key -> {value, until}
  let uuidCounter = 0;

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    parseInt,
    isNaN,
    Number,
    String,
    Object,
    Array,
    Error,

    SpreadsheetApp: {
      getActive: () => spreadsheet,
      openById: () => spreadsheet,
    },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => { properties.set(k, String(v)); },
        deleteProperty: k => { properties.delete(k); },
      }),
    },

    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
    },

    Logger: { log: (...args) => logs.push(args.join(' ')) },

    /* Gmail stands in as an outbox the tests can read. */
    MailApp: {
      sendEmail(options) {
        if (typeof options === 'string') options = { to: options };
        outbox.push(options);
      },
      getRemainingDailyQuota: () => 100 - outbox.length,
    },

    Session: { getScriptTimeZone: () => 'UTC' },

    /* Presence is kept in the cache rather than the spreadsheet, so the stub honours the expiry
       it is given: that is the whole behaviour being relied on. */
    CacheService: {
      getScriptCache: () => ({
        get(key) {
          const entry = cache.get(key);
          if (!entry) return null;
          if (entry.until <= Date.now()) { cache.delete(key); return null; }
          return entry.value;
        },
        getAll(keys) {
          const out = {};
          for (const key of keys) {
            const value = this.get(key);
            if (value !== null) out[key] = value;
          }
          return out;
        },
        put(key, value, seconds) {
          cache.set(key, { value: String(value), until: Date.now() + (Number(seconds) || 600) * 1000 });
        },
        remove(key) { cache.delete(key); },
      }),
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({
        _text: text,
        setMimeType() { return this; },
        getContent() { return this._text; },
      }),
    },

    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(_algorithm, value) {
        const input = typeof value === 'string'
          ? Buffer.from(value, 'utf8')
          : Buffer.from(value.map(b => (b + 256) % 256));
        const digest = crypto.createHash('sha256').update(input).digest();
        /* Apps Script hands back signed bytes; mirror that so the code is exercised honestly. */
        return Array.from(digest).map(b => (b > 127 ? b - 256 : b));
      },
      base64EncodeWebSafe(bytes) {
        const buf = Buffer.from(bytes.map(b => (b + 256) % 256));
        return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      },
      getUuid() {
        uuidCounter += 1;
        return crypto.randomUUID() + '-' + uuidCounter;
      },
      formatDate(date, tz, _format) {
        /* Only the one format the backend asks for, but the timezone is honoured – that is the
           whole point of the call. */
        const shift = tz === FAKE_TIME_ZONE ? TZ_OFFSET_HOURS * 3600 * 1000 : 0;
        return new Date(date.getTime() + shift).toISOString().slice(0, 10);
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODE, 'utf8'), sandbox, { filename: 'Code.gs' });

  /** Call an action the way the deployed Web App would, and unwrap the JSON. */
  const call = (action, body = {}) => {
    const output = sandbox.doPost({ postData: { contents: JSON.stringify({ action, ...body }) } });
    return JSON.parse(output.getContent());
  };

  return { sandbox, call, spreadsheet, properties, cache, logs, outbox, TEAM_TAB, TEAM_HEADERS, TASK_TAB, TASK_HEADERS };
}

module.exports = { load };
