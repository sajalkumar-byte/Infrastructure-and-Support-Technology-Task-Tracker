'use strict';
/* loader.test.js – the short file people actually paste into Apps Script.

   It downloads Code.gs and runs it, so the whole tracker has to work through it exactly as it
   would if the big file had been pasted directly. Here the download is served from disk. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load } = require('./harness');

const LOADER = path.resolve(__dirname, '..', 'Loader.gs');
const CODE = path.resolve(__dirname, '..', 'Code.gs');

/** Build a sandbox running Loader.gs, with the download and the cache stood in for. */
function loadViaLoader({ source = null, status = 200 } = {}) {
  const world = load();
  const fetches = [];
  const cache = new Map();

  world.sandbox.UrlFetchApp = {
    fetch(url) {
      fetches.push(url);
      const body = source === null ? fs.readFileSync(CODE, 'utf8') : source;
      return { getResponseCode: () => status, getContentText: () => body };
    },
  };
  world.sandbox.CacheService = {
    getScriptCache: () => ({
      get: k => (cache.has(k) ? cache.get(k) : null),
      put: (k, v) => cache.set(k, v),
      remove: k => cache.delete(k),
    }),
  };

  vm.runInContext(fs.readFileSync(LOADER, 'utf8'), world.sandbox, { filename: 'Loader.gs' });

  const call = (action, body = {}) => {
    const out = world.sandbox.doPost({ postData: { contents: JSON.stringify({ action, ...body }) } });
    return JSON.parse(out.getContent());
  };
  return { ...world, call, fetches, cache };
}

test('the loader is short enough that nobody can paste the wrong thing', () => {
  const text = fs.readFileSync(LOADER, 'utf8');
  const lines = text.split('\n').length;
  assert.ok(lines < 140, `the loader should stay small, it is ${lines} lines`);
  assert.ok(!/\bwindow\b/.test(text), 'and must never mention window');
  assert.match(text, /raw\.githubusercontent\.com/);
});

test('the loader names every service, so the right permissions are requested', () => {
  /* Apps Script decides which permissions to ask for by reading the code in the editor. The
     real tracker arrives through eval, where the scanner cannot see it, so the loader has to
     mention each service itself or the first spreadsheet call is refused. */
  const text = fs.readFileSync(LOADER, 'utf8');
  const code = fs.readFileSync(CODE, 'utf8');

  const SERVICES = ['SpreadsheetApp', 'MailApp', 'UrlFetchApp', 'CacheService',
                    'PropertiesService', 'LockService', 'Utilities', 'Session',
                    'DriveApp', 'GmailApp', 'CalendarApp'];

  const mentions = (haystack, service) => haystack.indexOf(service + '.') !== -1;

  for (const service of ['SpreadsheetApp', 'MailApp', 'UrlFetchApp', 'CacheService']) {
    assert.ok(mentions(text, service), `the loader must mention ${service}`);
  }
  /* Anything Code.gs uses must be listed too, or a service added later hits the same wall. */
  for (const service of SERVICES) {
    if (mentions(code, service)) {
      assert.ok(mentions(text, service), `Code.gs uses ${service}; the loader must mention it too`);
    }
  }
});

test('the permission hints never actually run', () => {
  const { sandbox } = loadViaLoader();
  let touched = false;
  sandbox.MailApp = { sendEmail() { touched = true; }, getRemainingDailyQuota() { touched = true; return 0; } };
  sandbox._permissionsNeeded_();
  assert.equal(touched, false, 'it must return before calling anything');
});

test('the whole tracker works through the loader', () => {
  const { call, sandbox, fetches } = loadViaLoader();

  assert.equal(call('health').setupRequired, true);
  sandbox.setupTracker();
  assert.equal(call('health').setupRequired, false);
  assert.ok(fetches.length >= 1, 'it downloaded the real code');

  const session = call('login', { email: 'admin@tracker.com', password: 'Admin@1234' });
  assert.ok(session.token);
  assert.equal(session.user.role, 'superadmin');

  const item = call('saveItem', {
    token: session.token,
    item: { type: 'Project', title: 'Core banking DR site', f1: 'Rafiqul Islam' },
  });
  assert.equal(item.id, 'P-1');
  assert.equal(call('listItems', { token: session.token }).items.length, 1);
});

test('the roles still hold when loaded this way', () => {
  const { call, sandbox } = loadViaLoader();
  sandbox.setupTracker();
  const boss = call('login', { email: 'admin@tracker.com', password: 'Admin@1234' }).token;
  call('createUser', { token: boss, email: 's@x.com', name: 'S', role: 'superuser', password: 'superpw' });
  const superuser = call('login', { email: 's@x.com', password: 'superpw' }).token;

  assert.equal(call('saveItem', { token: superuser, item: { type: 'Project', title: 'No', f1: 'S' } }).error.code, 'forbidden');
  assert.ok(!call('saveItem', { token: superuser, item: { type: 'Task', title: 'Yes', f1: 'S' } }).error);
});

test('the sample data and the self-check run through the loader', () => {
  const { sandbox, call, properties } = loadViaLoader();
  sandbox.setupTracker();
  /* Sample rows land in the team's own tab, so they have to be asked for. */
  properties.set('ALLOW_SAMPLE_DATA', 'yes');
  assert.equal(sandbox.addSampleData(), 13);
  assert.equal(sandbox.addSampleUsers(), 3);
  assert.equal(sandbox.checkDeployment().length, 0);

  const boss = call('login', { email: 'admin@tracker.com', password: 'Admin@1234' }).token;
  assert.equal(call('listItems', { token: boss }).items.length, 13);
});

test('the code is downloaded once and then cached', () => {
  const { call, sandbox, fetches, cache } = loadViaLoader();
  sandbox.setupTracker();
  call('health'); call('health'); call('health');
  assert.equal(fetches.length, 1, 'one download, not one per call');
  assert.ok(cache.has('tracker_src'));
});

test('refreshTrackerCode fetches again, which is how an update arrives', () => {
  const { sandbox, fetches } = loadViaLoader();
  sandbox.setupTracker();
  const before = fetches.length;
  sandbox.refreshTrackerCode();
  assert.equal(fetches.length, before + 1);
});

test('a failed or wrong download is reported, not half-run', () => {
  assert.throws(() => {
    const w = loadViaLoader({ status: 404 });
    w.sandbox.setupTracker();
  }, /HTTP 404/);

  assert.throws(() => {
    const w = loadViaLoader({ source: '(function(global){ global.oops = 1; })(window);' });
    w.sandbox.setupTracker();
  }, /does not look like the tracker code/);
});
