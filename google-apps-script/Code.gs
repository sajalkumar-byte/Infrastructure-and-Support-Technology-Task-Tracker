/**
 * Task and Project Tracker – Google Sheets backend (Google Apps Script)
 * =====================================================================
 *
 * A complete backend where the database is a Google Spreadsheet. Deploy this file as a Web App
 * and the tracker page talks to it exactly as it talks to the Node.js server: same accounts,
 * same four roles, same rules, enforced here rather than in the browser.
 *
 * Nothing to host and nothing to pay for. The data lives in a spreadsheet you own and can open,
 * sort and chart like any other sheet.
 *
 *   1. Open https://sheets.new and give the spreadsheet a name.
 *   2. Extensions → Apps Script. Delete the sample code, paste this whole file, save.
 *   3. Run the function  setupTracker  once and allow the permissions it asks for.
 *   4. Deploy → New deployment → Web app
 *         Execute as:        Me
 *         Who has access:    Anyone            ← required, the page is not signed in to Google
 *      Copy the /exec URL it gives you.
 *   5. In index.html, before js/gsheet.js, add:
 *         set GAS_URL in index.html to the /exec address this deployment gives you.
 *
 * After step 3 the sheet contains the tabs Users, Items, Sessions, Requests and Audit, plus a
 * super admin to sign in with. The password is printed in the run log and can be changed in the
 * Script Properties before you run it:  SEED_EMAIL, SEED_NAME, SEED_PASSWORD.
 *
 * Security notes
 *   · Passwords are stored as salted, repeatedly hashed SHA-256, never in plain text.
 *   · Session tokens are random and the sheet keeps only their hash.
 *   · Every role check happens in this file, so a Viewer calling the URL directly still gets a
 *     refusal. Hiding a button in the browser is convenience, not protection.
 *   · "Anyone" access means anyone who knows the URL may CALL the script, not that they can read
 *     the spreadsheet. Every action except health, setup and login requires a valid token.
 */

/* ===================================================================== */
/* Configuration                                                          */
/* ===================================================================== */

/* The tabs this script owns outright. They are created hidden and prefixed, so a workbook
   people keep by hand does not fill up with the software's plumbing. The items themselves are
   NOT here - they live in the tab the team already uses, see the adapter further down. */
var SHEETS = {
  users:    { name: 'Tracker Users',    headers: ['email', 'name', 'role', 'password', 'externalId', 'createdAt', 'createdBy', 'updatedAt', 'lastLogin'] },
  itemmeta: { name: 'Tracker Item Meta', headers: ['id', 'type', 'role', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'owned'] },
  sessions: { name: 'Tracker Sessions', headers: ['tokenHash', 'email', 'createdAt', 'expiresAt', 'userAgent'] },
  requests: { name: 'Tracker Requests', headers: ['id', 'email', 'name', 'at'] },
  archive:  { name: 'Tracker Archive',  headers: ['id', 'rows', 'at'] },
  resets:   { name: 'Tracker Resets',   headers: ['email', 'codeHash', 'expiresAt', 'attempts', 'createdAt'] },
  audit:    { name: 'Tracker Audit',    headers: ['at', 'actor', 'role', 'action', 'target', 'detail'] },
  messages: { name: 'Tracker Messages', headers: ['id', 'conversation', 'fromEmail', 'toEmail', 'body', 'at', 'readAt'] }
};

var ROLES = ['superadmin', 'admin', 'superuser', 'viewer'];

var ROLE_LABEL = {
  superadmin: 'Super admin', admin: 'Admin', superuser: 'Superuser', viewer: 'Viewer'
};

var ROLE_DESCRIPTION = {
  superadmin: 'Full access, plus user and role management',
  admin: 'Create, edit, delete and export everything',
  superuser: 'View everything · create and edit Tasks · export',
  viewer: 'View only'
};

/* Which item types each role may create, edit and delete. This is the whole permission model. */
/* A newline, written without an escape so the character cannot be mangled in transit. */
var NL = String.fromCharCode(10);

var WRITABLE_TYPES = {
  superadmin: ['Project', 'Drive', 'Task'],
  admin:      ['Project', 'Drive', 'Task'],
  superuser:  ['Task'],
  viewer:     []
};

/* ---------- the role-by-role tabs in the spreadsheet ----------

   Items stays the one place a row is ever written. These extra tabs hold a single live FILTER
   formula over it, so each role's work shows up on its own tab, split by type, and the views
   cannot drift out of step with the data: change a row in Items, edit it in the page, or delete
   it, and every tab that should show it follows on its own.

   Which tabs exist comes from the permission model above, so a role that cannot create
   Recurring items never gets an empty Recurring tab, and a change there is reflected the next
   time rebuildViews runs. */

var TYPE_TAB = { Project: 'Projects', Drive: 'Recurring', Task: 'Tasks' };

function viewTabs_() {
  var views = [];
  ROLES.forEach(function (role) {
    var label = ROLE_LABEL[role] || role;
    /* everything this role created, whatever the type */
    views.push({ name: label + ' data', role: role, type: '' });
    /* then one tab per type it is allowed to create */
    (WRITABLE_TYPES[role] || []).forEach(function (type) {
      views.push({ name: label + ' ' + TYPE_TAB[type], role: role, type: type });
    });
  });
  return views;
}

function columnLetter_(index) {
  var letters = '';
  var n = index;
  while (n >= 0) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  }
  return letters;
}

/** A tab name as a formula writes it: quoted, because these have spaces and an ampersand. */
function quoteSheet_(name) {
  return "'" + String(name).replace(/'/g, "''") + "'";
}

/**
 * One role's rows, pulled live out of the team's tab.
 *
 * Which role created a row is the script's own bookkeeping, kept in its hidden meta tab
 * rather than in a column added to their sheet - so the view has to join the two by id.
 * COUNTIFS takes the whole id column as its criteria and answers per row, which is what
 * makes that join possible in a single formula.
 */
function viewFormula_(view) {
  var items = quoteSheet_(itemSheetName_());
  var meta = quoteSheet_(SHEETS.itemmeta.name);
  var rows = items + '!A2:' + columnLetter_(ITEM_WIDTH - 1);
  var match = 'COUNTIFS(' + meta + '!$A$2:$A, ' + items + '!A2:A, '
    + meta + '!$B$2:$B, "' + view.role + '")>0';
  var filter = 'FILTER(' + rows + ', ' + match;
  if (view.type) filter += ', ' + items + '!B2:B="' + view.type + '"';
  filter += ')';
  /* Grouped by type, then in the order the ids were given out. A role with nothing to show
     gets an empty tab rather than #N/A. */
  return '=IFERROR(SORT(' + filter + ', 2, TRUE, 1, TRUE), "")';
}

/** The accounts themselves, gathered by role, so who holds which role is one glance. */
var ACCOUNTS_VIEW = 'Accounts by role';

function accountsFormula_() {
  var headers = SHEETS.users.headers;
  var last = columnLetter_(headers.length - 1);
  var keep = [];
  var users = quoteSheet_(SHEETS.users.name);
  headers.forEach(function (header, i) {
    if (header !== 'password') keep.push(users + '!' + columnLetter_(i) + '2:' + columnLetter_(i));
  });
  /* Everything but the password column, which no view has any business repeating. */
  return '=IFERROR(SORT(FILTER({' + keep.join(', ') + '}, ' + users + '!A2:A<>""), 3, TRUE, 1, TRUE), "")';
}

/**
 * Create or refresh every view tab. Safe to run again at any time: each tab is rebuilt from
 * the formula, so one that somebody typed over comes back.
 */
function rebuildViews() {
  var ss = spreadsheet_();
  /* The views repeat the team's own headings, so a view reads like the tab it came from. */
  var itemHeaders = itemSheet_().getRange(1, 1, 1, ITEM_WIDTH).getValues()[0];
  var made = [];

  viewTabs_().forEach(function (view) {
    var sh = ss.getSheetByName(view.name);
    if (!sh) sh = ss.insertSheet(view.name);
    sh.clear();
    sh.getRange(1, 1, 1, itemHeaders.length).setValues([itemHeaders]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, 1).setFormula(viewFormula_(view));
    made.push(view.name);
  });

  var accountHeaders = SHEETS.users.headers.filter(function (h) { return h !== 'password'; });
  var accounts = ss.getSheetByName(ACCOUNTS_VIEW);
  if (!accounts) accounts = ss.insertSheet(ACCOUNTS_VIEW);
  accounts.clear();
  accounts.getRange(1, 1, 1, accountHeaders.length).setValues([accountHeaders]).setFontWeight('bold');
  accounts.setFrozenRows(1);
  accounts.getRange(2, 1).setFormula(accountsFormula_());
  made.push(ACCOUNTS_VIEW);

  Logger.log('Views rebuilt: %s', made.join(', '));
  return made;
}

var CAPABILITIES = {
  superadmin: { view: true, export: true, manageUsers: true, viewAudit: true },
  admin:      { view: true, export: true, manageUsers: false, viewAudit: false },
  superuser:  { view: true, export: true, manageUsers: false, viewAudit: false },
  viewer:     { view: true, export: false, manageUsers: false, viewAudit: false }
};

var TYPES = ['Project', 'Drive', 'Task'];
var STATUSES = ['Ongoing', 'On Hold', 'Listed', 'Closed', 'Done'];
var PRIORITIES = ['High', 'Mid', 'Low'];
var PREFIX = { Project: 'P', Drive: 'D', Task: 'T' };

var SESSION_HOURS = 12;
/* Sending a forgotten-password code by email. Off, because the tracker does not need it to
   work: a super admin sets a new password from the Team tab, which is one step either way and
   leaves no code in a mailbox. Set this to true to offer it again. */
var ALLOW_EMAIL_RESET = false;

var HASH_ROUNDS = 500;          // raise for more protection, lower if sign-in feels slow
var LOGIN_MAX_ATTEMPTS = 8;
var LOGIN_WINDOW_MIN = 15;
var RESET_CODE_MINUTES = 15;       // how long an emailed code stays usable
var RESET_MAX_TRIES = 5;           // wrong codes allowed before the code is thrown away
var RESET_MAX_REQUESTS = 5;        // codes one address may ask for inside the window below
var RESET_REQUEST_WINDOW_MIN = 60;

/* ===================================================================== */
/* One-time setup – run this function from the editor                     */
/* ===================================================================== */

function setupTracker() {
  var ss = spreadsheet_();
  Object.keys(SHEETS).forEach(function (key) { sheet_(key); });
  /* All three are safe to repeat, and together they bring a sheet made by an earlier version
     up to date: the date columns, the header rows, and the role of each existing row. */
  Object.keys(SHEETS).forEach(function (key) { markDayColumnsAsText_(key); });
  Object.keys(SHEETS).forEach(function (key) { ensureHeaders_(key); });

  var props = PropertiesService.getScriptProperties();
  var email = (props.getProperty('SEED_EMAIL') || 'admin@tracker.com').toLowerCase();
  var name = props.getProperty('SEED_NAME') || 'Super admin';
  var password = props.getProperty('SEED_PASSWORD') || 'Admin@1234';
  var adminEmail = (props.getProperty('SEED_ADMIN_EMAIL') || 'testadmin@gmail.com').toLowerCase();
  var adminName = props.getProperty('SEED_ADMIN_NAME') || 'test admin';
  var adminPassword = props.getProperty('SEED_ADMIN_PASSWORD') || 'testpass';

  var existing = readTable_('users');
  if (existing.length) {
    Logger.log('Users sheet already has %s account(s) – nothing seeded.', existing.length);
  } else {
    /* The sign-in page offers two accounts whether or not a server is connected. If only the
       super admin existed here, signing in as the Admin would work in the browser-only mode and
       be refused by the spreadsheet - and anything created in between would sit on one device
       instead of reaching this sheet. Both accounts start out in both places. */
    appendRow_('users', {
      email: email, name: name, role: 'superadmin',
      password: hashPassword_(password), externalId: '',
      createdAt: nowIso_(), createdBy: 'setup', updatedAt: '', lastLogin: ''
    });
    appendRow_('users', {
      email: adminEmail, name: adminName, role: 'admin',
      password: hashPassword_(adminPassword), externalId: '',
      createdAt: nowIso_(), createdBy: 'setup', updatedAt: '', lastLogin: ''
    });
    Logger.log('Admin created.' + NL + '  email:    %s' + NL + '  password: %s', adminEmail, adminPassword);
    Logger.log('Super admin created.\n  email:    %s\n  password: %s\nChange it after the first sign-in.', email, password);
  }

  /* The items tab is the team's, so setup only checks it is there and reports what it found.
     It writes nothing into it, and it does not build the role views: those add tabs to a
     workbook people keep by hand, so they are opt-in - run rebuildViews when you want them. */
  var items = readItems_();
  Logger.log('Read %s row(s) from "%s" and "%s"; none changed.', items.length, itemSheetName_(), taskSheetName_());
  Logger.log('Run rebuildViews() if you want a tab per role. Nothing else here touches your tabs.');

  Logger.log('Spreadsheet: %s', ss.getUrl());
  Logger.log('Now use Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).');
  return 'Setup complete – see the execution log.';
}

/**
 * Fill the sheet with realistic sample rows so you can see the tracker working straight away.
 * Run it from the editor (choose addSampleData, press Run). Safe to run twice: a row whose title
 * is already there is skipped. Delete them from the Items tab whenever you want them gone.
 */
function addSampleData() {
  /* Sample rows go into the team's own tab, where real work lives. That is fine on a sheet
     made for trying the app out and quite wrong on this one, so it refuses unless somebody
     deliberately sets ALLOW_SAMPLE_DATA to yes in the script properties. */
  var allow = '';
  try { allow = PropertiesService.getScriptProperties().getProperty('ALLOW_SAMPLE_DATA') || ''; } catch (err) {}
  if (String(allow).toLowerCase() !== 'yes') {
    Logger.log('Refused: this would write made-up rows into "%s", which is a real working tab.'
      + NL + 'Set the script property ALLOW_SAMPLE_DATA to yes if you really want them.', itemSheetName_());
    return 0;
  }

  var samples = [
    /* type, title, status, priority, focal-1, focal-2, start, end, stakeholder, milestones */
    ['Project', 'Core banking DR site', 'Ongoing', 'High', 'Rafiqul Islam', 'Nadia Rahman', '2026-07-01', '2026-12-31', 'Operations', 'Requirement analysis - Done\nSite survey - Done\nHardware delivery - Ongoing\nFailover test - Listed'],
    ['Project', 'Branch Wi-Fi rollout (120 branches)', 'Ongoing', 'Mid', 'Nadia Rahman', '', '2026-08-15', '2027-01-31', 'Branch Operations', 'Vendor selection - Done\nPilot 10 branches - Done\nPhase 1 rollout - Ongoing'],
    ['Project', 'Ticketing system upgrade', 'On Hold', 'Mid', 'Rafiqul Islam', 'Sohel Mahmud', '2026-06-01', '2026-09-30', 'IT Service Desk', 'Licence renewal - Done\nData migration - on hold pending budget'],
    ['Project', 'Data centre cooling upgrade', 'Done', 'High', 'Sohel Mahmud', '', '2026-02-01', '2026-05-30', 'Facilities', 'Quotation - Done\nInstallation - Done\nLoad test - Done'],
    ['Project', 'Biometric attendance rollout', 'Listed', 'Low', 'Nadia Rahman', '', '2027-01-05', '2027-06-30', 'Human Resources', ''],

    ['Drive', 'Monthly backup restore test', 'Ongoing', 'High', 'Sohel Mahmud', 'Rafiqul Islam', '2026-01-01', '', 'Risk and Compliance', 'Restore drill on the first Sunday of each month'],
    ['Drive', 'Weekly server patching', 'Ongoing', 'Mid', 'Rafiqul Islam', '', '2026-01-01', '', 'Infrastructure', 'Windows and Linux fleet, Thursday night window'],
    ['Drive', 'Quarterly disaster recovery drill', 'Ongoing', 'High', 'Nadia Rahman', 'Sohel Mahmud', '2026-01-01', '', 'Operations', 'Q1 - Done\nQ2 - Done\nQ3 - Ongoing'],

    ['Task', 'Replace UPS battery - Head Office', 'Ongoing', 'High', 'Sohel Mahmud', '', '2026-10-01', '2026-10-25', 'Facilities', 'Quotation - Done\nFitting scheduled - Ongoing'],
    ['Task', 'Renew wildcard SSL certificate', 'Done', 'High', 'Rafiqul Islam', '', '2026-09-01', '2026-09-20', 'Security', 'Purchase - Done\nInstall on load balancer - Done'],
    ['Task', 'Reset VPN tokens for field staff', 'Ongoing', 'Mid', 'Nadia Rahman', '', '2026-10-05', '2026-10-30', 'Field Operations', ''],
    ['Task', 'Decommission old file server', 'Listed', 'Low', 'Sohel Mahmud', '', '2026-11-01', '2026-11-30', 'Infrastructure', ''],
    ['Task', 'Audit firewall rules', 'On Hold', 'Mid', 'Rafiqul Islam', 'Nadia Rahman', '2026-08-01', '2026-09-15', 'Security', 'Rule export - Done\nReview with vendor - on hold']
  ];

  var existing = readTable_('items');
  var titles = {};
  existing.forEach(function (row) { titles[String(row.title)] = true; });

  var added = 0;
  samples.forEach(function (sample) {
    if (titles[sample[1]]) return;
    var record = {
      id: nextId_(sample[0], existing),
      type: sample[0], title: sample[1], s: sample[2], pri: sample[3],
      f1: sample[4], f2: sample[5], sd: sample[6], e: sample[7],
      sh: sample[8], ms: sample[9], rm: '',
      createdAt: nowIso_(), createdBy: 'sample data', updatedAt: '', updatedBy: '',
      /* Spread across the roles that would really have created this kind of work, so the
         role tabs have something in them to look at. */
      role: sample[0] === 'Task' ? 'superuser' : 'admin'
    };
    appendRow_('items', record);
    existing.push(record);
    added += 1;
  });

  Logger.log('Added %s sample row(s); %s were already there.', added, samples.length - added);
  return added;
}

/**
 * Create one account per role so all four can be tried immediately.
 * Run it from the editor. The passwords are printed in the log - change them before real use.
 */
function addSampleUsers() {
  var people = [
    { email: 'admin2@tracker.com', name: 'Rafiqul Islam', role: 'admin', password: 'Admin2@1234' },
    { email: 'superuser@tracker.com', name: 'Sohel Mahmud', role: 'superuser', password: 'Super@1234' },
    { email: 'viewer@tracker.com', name: 'Nadia Rahman', role: 'viewer', password: 'Viewer@1234' }
  ];
  var added = 0;
  people.forEach(function (p) {
    if (findUser_(p.email)) { Logger.log('%s already exists - skipped.', p.email); return; }
    appendRow_('users', {
      email: p.email, name: p.name, role: p.role, password: hashPassword_(p.password),
      externalId: '', createdAt: nowIso_(), createdBy: 'sample', updatedAt: '', lastLogin: ''
    });
    Logger.log('%s  role: %s  password: %s', p.email, p.role, p.password);
    added += 1;
  });
  Logger.log('Added %s account(s). Change these passwords before real use.', added);
  return added;
}

/**
 * Check the installation and say what is wrong, if anything.
 * Run it from the editor after pasting this file or changing settings.
 */
function checkDeployment() {
  var problems = [];
  try { spreadsheet_(); } catch (err) { problems.push('No spreadsheet: ' + err.message); }

  Object.keys(SHEETS).forEach(function (key) {
    if (!spreadsheet_().getSheetByName(SHEETS[key].name)) {
      problems.push('Missing tab: ' + SHEETS[key].name + ' - run setupTracker');
    }
  });

  /* The items tab belongs to the team, so it is checked rather than created. */
  try {
    var sh = itemSheet_();
    var headers = sh.getRange(1, 1, 1, ITEM_WIDTH).getValues()[0];
    if (String(headers[ITEM_COL.id - 1]).toLowerCase().indexOf('id') === -1 ||
        String(headers[ITEM_COL.title - 1]).toLowerCase().indexOf('title') === -1) {
      problems.push('The columns of "' + itemSheetName_() + '" are not where this expects them: '
        + 'column A should be the ID and column E the Title.');
    }
    Logger.log('projects tab: "%s" with %s row(s)', itemSheetName_(), Math.max(sh.getLastRow() - 1, 0));
    var tasks = taskSheet_();
    var taskHeaders = tasks.getRange(1, 1, 1, TASK_WIDTH).getValues()[0];
    if (String(taskHeaders[TASK_COL.title - 1]).toLowerCase().indexOf('title') === -1) {
      problems.push('The columns of "' + taskSheetName_() + '" are not where this expects them: '
        + 'column F should be the Task Title.');
    }
    Logger.log('tasks tab:    "%s" with %s row(s)', taskSheetName_(), Math.max(tasks.getLastRow() - 1, 0));
  } catch (err) { problems.push(err.message); }

  var users = readTable_('users');
  if (!users.length) problems.push('No accounts yet - run setupTracker');
  users.forEach(function (u) {
    if (String(u.password).indexOf('sha256$') !== 0) {
      problems.push('The password for ' + u.email + ' is not hashed - reset it from the Users dialog');
    }
  });

  Logger.log('health:   %s', JSON.stringify(ACTIONS.health()));
  Logger.log('accounts: %s     items: %s', users.length, readTable_('items').length);
  if (ALLOW_EMAIL_RESET) {
    try {
      Logger.log('email quota left today: %s', MailApp.getRemainingDailyQuota());
    } catch (err) { problems.push('Email is not available: ' + err.message); }
  } else {
    Logger.log('email: switched off, which is what ALLOW_EMAIL_RESET false means');
  }

  if (problems.length) {
    Logger.log('PROBLEMS FOUND:');
    problems.forEach(function (p) { Logger.log('  - %s', p); });
  } else {
    Logger.log('Everything looks correct.');
    Logger.log('If the page still cannot reach this script, publish the current code:');
    Logger.log('Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy.');
  }
  return problems;
}

/** Optional helper: remove expired sessions. Add a time-driven trigger for it if you like. */
function cleanUpSessions() {
  var rows = readTable_('sessions');
  var now = new Date().getTime();
  var keep = rows.filter(function (r) { return new Date(r.expiresAt).getTime() > now; });
  if (keep.length !== rows.length) {
    writeTable_('sessions', keep);
    Logger.log('Removed %s expired session(s).', rows.length - keep.length);
  }
  return keep.length;
}

/* ===================================================================== */
/* Web App entry points                                                   */
/* ===================================================================== */

/**
 * The page sends POST requests with Content-Type text/plain, which browsers treat as a "simple"
 * request: no CORS preflight, which Apps Script cannot answer.
 */
function doPost(e) {
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ error: { code: 'bad_json', message: 'The request body is not valid JSON' } });
  }
  return handle_(body, e);
}

/** GET is supported for health checks and for opening the URL in a browser to test it. */
function doGet(e) {
  var params = (e && e.parameter) || {};
  if (!params.action) {
    return json_({
      ok: true, service: 'task-tracker-gas',
      message: 'The tracker backend is running. The page talks to it with POST requests.',
      setupRequired: readTable_('users').length === 0
    });
  }
  return handle_(params, e);
}

/** Every action is dispatched here, so GET and POST behave identically. */
function handle_(body, e) {
  var action = String(body.action || '');
  try {
    var handler = ACTIONS[action];
    if (!handler) return json_({ error: { code: 'not_found', message: 'Unknown action: ' + action } });

    /* Actions that work without being signed in. */
    var open = { health: 1, setup: 1, login: 1, roles: 1, createRequest: 1, me: 1,
                 forgotPassword: 1, resetPassword: 1 };
    var ctx = { user: null, token: String(body.token || '') };
    if (ctx.token) ctx.user = userForToken_(ctx.token);
    if (!open[action] && !ctx.user) {
      return json_({ error: { code: 'unauthorized', message: 'Please sign in to continue' } });
    }
    return json_(handler(body, ctx, e));
  } catch (err) {
    var status = err && err.status ? err.status : 500;
    var code = err && err.code ? err.code : 'server_error';
    var message = (err && err.message) ? String(err.message) : 'Something went wrong';
    if (status === 500) Logger.log('Error in %s: %s', action, (err && err.stack) || message);
    return json_({ error: { code: code, message: message, status: status } });
  }
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(status, code, message) {
  var err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/* ===================================================================== */
/* Actions                                                                */
/* ===================================================================== */

var ACTIONS = {

  /* ---------- open ---------- */

  health: function () {
    return {
      ok: true, service: 'task-tracker-gas', version: '1.0.0',
      time: nowIso_(), setupRequired: readTable_('users').length === 0, roles: ROLES,
      /* So the page knows whether to offer "Forgot your password?" at all. */
      email: ALLOW_EMAIL_RESET
    };
  },

  roles: function () {
    return { roles: ROLES.map(describeRole_) };
  },

  /** Create the first super admin. Refused once any account exists. */
  setup: function (body, ctx, e) {
    return withLock_(function () {
      if (readTable_('users').length) throw fail_(400, 'already_setup', 'Setup has already been completed – please sign in');
      var user = createUser_({
        email: body.email, name: body.name, role: 'superadmin',
        password: body.password, createdBy: 'setup'
      });
      var session = createSession_(user.email, e);
      audit_('setup', user.email, 'superadmin', user.email, '');
      return sessionPayload_(user, session);
    });
  },

  login: function (body, ctx, e) {
    var email = normaliseEmail_(body.email);
    var password = String(body.password || '');
    if (!email || !password) throw fail_(400, 'missing_credentials', 'Enter your email and password');

    throttleLogin_(email);

    var row = findUser_(email);
    var ok = row && verifyPassword_(password, row.password);
    if (!ok) {
      audit_('login.failed', email, '', email, '');
      throw fail_(401, 'unauthorized', 'Email or password is not correct');
    }
    clearThrottle_(email);

    var session = createSession_(row.email, e);
    updateUserRow_(row.email, { lastLogin: nowIso_() });
    audit_('login', row.email, row.role, row.email, '');
    return sessionPayload_(publicUser_(row), session);
  },

  me: function (body, ctx) {
    if (!ctx.user) {
      return { user: null, permissions: null, setupRequired: readTable_('users').length === 0,
               roles: ROLES.map(describeRole_) };
    }
    return {
      user: { email: ctx.user.email, name: ctx.user.name, role: ctx.user.role, id: docId_(ctx.user.email) },
      permissions: describeRole_(ctx.user.role),
      setupRequired: false,
      roles: ROLES.map(describeRole_)
    };
  },

  logout: function (body, ctx) {
    if (ctx.token) destroySession_(ctx.token);
    audit_('logout', ctx.user.email, ctx.user.role, ctx.user.email, '');
    return { ok: true };
  },

  changePassword: function (body, ctx, e) {
    var row = findUser_(ctx.user.email);
    /* 400, not 401: the person IS signed in, they just mistyped. A 401 here would make the
       page think the session had expired and sign them out. */
    if (!row || !verifyPassword_(String(body.currentPassword || ''), row.password)) {
      throw fail_(400, 'bad_current', 'Your current password is not correct');
    }
    var next = String(body.newPassword || '');
    if (next.length < 4) throw fail_(400, 'bad_password', 'The new password must be at least 4 characters');
    updateUserRow_(row.email, { password: hashPassword_(next), updatedAt: nowIso_() });
    /* Your other devices are signed out, but the one you are using stays signed in. */
    destroySessionsFor_(row.email, ctx.token);
    audit_('password.change', row.email, row.role, row.email, '');
    return { ok: true, message: 'Your password has been changed.' };
  },


  /** Change your own display name. Your email and role are not touched here. */
  updateProfile: function (body, ctx) {
    var name = String(body.name || '').trim();
    if (!name) throw fail_(400, 'bad_name', 'Enter a name');
    if (name.length > 120) throw fail_(400, 'bad_name', 'That name is too long');
    return withLock_(function () {
      updateUserRow_(ctx.user.email, { name: name, updatedAt: nowIso_() });
      audit_('profile.update', ctx.user.email, ctx.user.role, ctx.user.email, 'name');
      return publicUser_(findUser_(ctx.user.email));
    });
  },

  /* ---------- forgotten password ---------- */

  /**
   * Step one: email a six-digit code to the address, if it has an account.
   * The answer is the same either way, so the script never reveals who has an account.
   */
  forgotPassword: function (body) {
    /* Refused before anything else, so no code is written for a message nobody will send. */
    if (!ALLOW_EMAIL_RESET) {
      throw fail_(400, 'mail_off',
        'Password reset by email is switched off here. Ask the super admin to set a new password for you.');
    }
    var email = normaliseEmail_(body.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw fail_(400, 'bad_email', 'Enter a valid email address');
    }
    throttleReset_(email);

    var user = findUser_(email);
    if (user) {
      var code = resetCode_();
      withLock_(function () { putReset_(email, code); });
      var delivered = sendResetEmail_(user, code);
      audit_('password.forgot', email, user.role, email, delivered ? 'code emailed' : 'email failed');
      if (!delivered) {
        throw fail_(500, 'mail_failed',
          'The code could not be emailed. Ask the super admin to reset your password instead.');
      }
    } else {
      audit_('password.forgot', email, '', email, 'no such account');
    }
    return {
      ok: true,
      message: 'If that address has an account, a six-digit code is on its way. It expires in '
        + RESET_CODE_MINUTES + ' minutes.'
    };
  },

  /** Step two: the code plus a new password. */
  resetPassword: function (body) {
    var email = normaliseEmail_(body.email);
    var code = String(body.code || '').replace(/\s+/g, '');
    var next = String(body.newPassword || '');
    if (next.length < 4) throw fail_(400, 'bad_password', 'The new password must be at least 4 characters');
    if (!code) throw fail_(400, 'bad_code', 'Enter the code from the email');

    return withLock_(function () {
      var row = findReset_(email);
      if (!row) throw fail_(400, 'bad_code', 'No code is waiting for that address - ask for a new one');

      if (new Date(row.expiresAt).getTime() <= new Date().getTime()) {
        removeReset_(email);
        throw fail_(400, 'expired_code', 'That code has expired - ask for a new one');
      }
      var attempts = Number(row.attempts || 0) + 1;
      if (attempts > RESET_MAX_TRIES) {
        removeReset_(email);
        throw fail_(429, 'too_many_tries', 'Too many wrong codes - ask for a new one');
      }
      if (hashCode_(email, code) !== String(row.codeHash)) {
        updateReset_(email, { attempts: attempts });
        throw fail_(400, 'bad_code', 'That code is not correct - ' + (RESET_MAX_TRIES - attempts) + ' tries left');
      }

      var user = findUser_(email);
      if (!user) { removeReset_(email); throw fail_(404, 'not_found', 'No account with that email'); }

      updateUserRow_(email, { password: hashPassword_(next), updatedAt: nowIso_() });
      removeReset_(email);
      destroySessionsFor_(email);          // any old sign-in of this account stops working
      clearThrottle_(email);
      audit_('password.reset', email, user.role, email, 'by emailed code');
      return { ok: true, message: 'Your password has been changed. Please sign in.' };
    });
  },

  /* ---------- items ---------- */

  listItems: function (body, ctx) {
    return { items: readTable_('items').map(itemOut_), role: ctx.user.role };
  },

  saveItem: function (body, ctx) {
    return withLock_(function () {
      var input = body.item || {};
      /* Only the envelope names a row to edit. A new item arrives without one and is given
         its id here, from what is actually in the sheet - the page's guess, made from whatever
         it had loaded, could match a row somebody else added since, and a create would then
         quietly overwrite it. */
      var id = String(body.id || '');
      var rows = readTable_('items');
      var index = -1;
      for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === id) { index = i; break; }

      if (id && index === -1) {
        throw fail_(404, 'not_found', 'That item is no longer in the spreadsheet - reload and try again');
      }

      if (index === -1) {
        /* Creating: the role must be allowed to write this type. */
        var type = String(input.type || '');
        assertWrite_(ctx.user.role, type);
        var created = cleanItem_(input, false);
        created.id = nextId_(created.type, rows);
        created.createdAt = nowIso_();
        created.createdBy = ctx.user.email;
        /* The role it was created with, so the spreadsheet can show each role its own work.
           It comes from the session, never from the request, and editing never rewrites it. */
        created.role = ctx.user.role;
        created.updatedAt = '';
        created.updatedBy = '';
        appendRow_('items', created);
        audit_('item.create', ctx.user.email, ctx.user.role, created.id, created.type + ': ' + created.title);
        return itemOut_(created);
      }

      /* Editing: the type ALREADY STORED decides, so a Superuser cannot pass a project off
         as a task by sending type:"Task". */
      assertWrite_(ctx.user.role, rows[index].type);
      var patch = cleanItem_(input, true);
      delete patch.type;
      var merged = rows[index];
      Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
      merged.updatedAt = nowIso_();
      merged.updatedBy = ctx.user.email;
      updateRowAt_('items', index, merged);
      audit_('item.update', ctx.user.email, ctx.user.role, merged.id, Object.keys(patch).join(','));
      return itemOut_(merged);
    });
  },

  deleteItem: function (body, ctx) {
    return withLock_(function () {
      var id = String(body.id || '');
      var rows = readTable_('items');
      var index = -1;
      for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === id) { index = i; break; }
      if (index === -1) throw fail_(404, 'not_found', 'That item no longer exists');
      assertWrite_(ctx.user.role, rows[index].type);
      var gone = rows[index];
      deleteRowAt_('items', index);
      audit_('item.delete', ctx.user.email, ctx.user.role, gone.id, gone.type + ': ' + gone.title);
      return { ok: true, id: gone.id };
    });
  },

  /* ---------- chat ---------- */

  /* Chat is open to every signed-in role: a Viewer may only read the tracker, but can still
     talk to colleagues. */

  chatContacts: function (body, ctx) {
    markSeen_(ctx.user.email);
    var contacts = chatSummary_(ctx.user.email);
    var online = onlineEmails_(contacts.map(function (c) { return c.email; }));
    var unread = 0;
    contacts.forEach(function (c) {
      c.online = online.indexOf(c.email) !== -1;
      unread += c.unread;
    });
    return {
      me: { email: ctx.user.email, name: ctx.user.name, role: ctx.user.role },
      contacts: contacts,
      unread: unread,
      /* No socket here, so the page polls instead of waiting to be pushed to. */
      realtime: false
    };
  },

  chatWith: function (body, ctx) {
    var other = findUser_(body.email);
    if (!other) throw fail_(404, 'not_found', 'No colleague with that email');
    markSeen_(ctx.user.email);

    var rows = conversationRows_(ctx.user.email, other.email);
    var since = String(body.since || '');
    if (since) rows = rows.filter(function (row) { return String(row.at) > since; });
    var limit = Math.min(Math.max(Number(body.limit) || 200, 1), 500);
    var marked = markConversationRead_(ctx.user.email, other.email);

    return {
      with: { email: other.email, name: other.name, role: other.role },
      messages: rows.slice(-limit).map(messageOut_),
      markedRead: marked
    };
  },

  chatSend: function (body, ctx) {
    var text = String(body.body === undefined || body.body === null ? '' : body.body).trim();
    if (!text) throw fail_(400, 'empty_message', 'Write a message first');
    if (text.length > MESSAGE_MAX_LENGTH) {
      throw fail_(400, 'too_long', 'A message can be at most ' + MESSAGE_MAX_LENGTH + ' characters');
    }
    var other = findUser_(body.email);
    if (!other) throw fail_(404, 'not_found', 'No colleague with that email');
    var sender = normaliseEmail_(ctx.user.email);
    var recipient = normaliseEmail_(other.email);
    if (sender === recipient) throw fail_(400, 'self_message', 'You cannot message yourself');

    markSeen_(ctx.user.email);
    return withLock_(function () {
      var row = {
        id: Utilities.getUuid(),
        conversation: conversationKey_(sender, recipient),
        fromEmail: sender, toEmail: recipient, body: text,
        at: nowIso_(), readAt: ''
      };
      appendRow_('messages', row);
      audit_('chat.send', sender, ctx.user.role, recipient, text.length + ' characters');
      return messageOut_(row);
    });
  },

  chatRead: function (body, ctx) {
    var other = findUser_(body.email);
    if (!other) throw fail_(404, 'not_found', 'No colleague with that email');
    markSeen_(ctx.user.email);
    return withLock_(function () {
      return { ok: true, marked: markConversationRead_(ctx.user.email, other.email) };
    });
  },

  chatUnread: function (body, ctx) {
    var mine = normaliseEmail_(ctx.user.email);
    var rows = readTable_('messages');
    var unread = 0;
    rows.forEach(function (row) {
      if (row.toEmail === mine && !String(row.readAt || '')) unread += 1;
    });
    return { unread: unread };
  },

  listArchive: function () {
    return {
      batches: readTable_('archive').map(function (b) {
        var rows = [];
        try { rows = JSON.parse(b.rows || '[]'); } catch (err) { rows = []; }
        return { id: b.id, rows: rows, at: b.at };
      })
    };
  },

  saveArchive: function (body, ctx) {
    assertWrite_(ctx.user.role, 'Project');       // an admin-level action
    return withLock_(function () {
      var id = String(body.id || '');
      var rows = Array.isArray(body.rows) ? body.rows : [];
      var table = readTable_('archive');
      var index = -1;
      for (var i = 0; i < table.length; i++) if (String(table[i].id) === id) { index = i; break; }
      var record = { id: id, rows: JSON.stringify(rows), at: nowIso_() };
      if (index === -1) appendRow_('archive', record); else updateRowAt_('archive', index, record);
      audit_('archive.save', ctx.user.email, ctx.user.role, id, rows.length + ' rows');
      return { id: id, rows: rows };
    });
  },

  /* ---------- users (super admin only) ---------- */

  listUsers: function (body, ctx) {
    assertCan_(ctx.user.role, 'manageUsers');
    return {
      users: readTable_('users').map(publicUser_),
      requests: readTable_('requests'),
      roles: ROLES.map(describeRole_)
    };
  },

  createUser: function (body, ctx) {
    assertCan_(ctx.user.role, 'manageUsers');
    return withLock_(function () {
      var user = createUser_({
        email: body.email, name: body.name, role: body.role,
        password: body.password, externalId: body.externalId, createdBy: ctx.user.email
      });
      if (body.requestId) removeRequest_(body.requestId);
      audit_('user.create', ctx.user.email, ctx.user.role, user.email, user.role);
      return user;
    });
  },

  updateUser: function (body, ctx) {
    assertCan_(ctx.user.role, 'manageUsers');
    return withLock_(function () {
      var email = normaliseEmail_(body.email || body.id);
      var row = findUser_(email);
      if (!row) throw fail_(404, 'not_found', 'No account with that email');

      var patch = {};
      if (body.name !== undefined) {
        var name = String(body.name).trim();
        if (!name) throw fail_(400, 'bad_name', 'Enter a name');
        patch.name = name;
      }
      if (body.role !== undefined) {
        if (ROLES.indexOf(body.role) === -1) throw fail_(400, 'bad_role', 'Role must be one of: ' + ROLES.join(', '));
        if (row.email === ctx.user.email && body.role !== row.role) {
          throw fail_(400, 'self_role', 'You cannot change your own role – ask another super admin');
        }
        if (row.role === 'superadmin' && body.role !== 'superadmin' && countSuperAdmins_() <= 1) {
          throw fail_(400, 'last_superadmin', 'This is the only super admin – promote someone else first');
        }
        patch.role = body.role;
      }
      if (body.password) {
        if (String(body.password).length < 4) throw fail_(400, 'bad_password', 'The password must be at least 4 characters');
        patch.password = hashPassword_(String(body.password));
      }
      if (body.externalId !== undefined) patch.externalId = String(body.externalId || '');
      patch.updatedAt = nowIso_();

      updateUserRow_(row.email, patch);

      /* A new role or password must not leave an old sign-in running with the old rights. */
      if (patch.role || patch.password) {
        if (row.email === ctx.user.email) destroySessionsFor_(row.email, ctx.token);
        else destroySessionsFor_(row.email);
      }
      audit_('user.update', ctx.user.email, ctx.user.role, row.email, Object.keys(patch).join(','));
      return publicUser_(findUser_(row.email));
    });
  },

  deleteUser: function (body, ctx) {
    assertCan_(ctx.user.role, 'manageUsers');
    return withLock_(function () {
      var email = normaliseEmail_(body.email || body.id);
      var rows = readTable_('users');
      var index = -1;
      for (var i = 0; i < rows.length; i++) if (rows[i].email === email) { index = i; break; }
      if (index === -1) throw fail_(404, 'not_found', 'No account with that email');
      if (email === ctx.user.email) throw fail_(400, 'self_delete', 'You cannot remove your own account');
      if (rows[index].role === 'superadmin' && countSuperAdmins_() <= 1) {
        throw fail_(400, 'last_superadmin', 'This is the only super admin – add another one first');
      }
      deleteRowAt_('users', index);
      destroySessionsFor_(email);
      /* Their conversations go too, so no thread is left pointing at an account that is gone. */
      removeMessagesFor_(email);
      audit_('user.delete', ctx.user.email, ctx.user.role, email, rows[index].role);
      return { ok: true, email: email };
    });
  },

  /* ---------- access requests ---------- */

  createRequest: function (body) {
    return withLock_(function () {
      var id = String(body.id || body.email || '').trim();
      if (!id) throw fail_(400, 'bad_request_id', 'A request needs an id or an email');
      var rows = readTable_('requests');
      for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === id) return { ok: true, id: id, existing: true };
      appendRow_('requests', {
        id: id, email: normaliseEmail_(body.email), name: String(body.name || ''), at: nowIso_()
      });
      return { ok: true, id: id, existing: false };
    });
  },

  deleteRequest: function (body, ctx) {
    assertCan_(ctx.user.role, 'manageUsers');
    removeRequest_(String(body.id || ''));
    audit_('request.remove', ctx.user.email, ctx.user.role, String(body.id || ''), '');
    return { ok: true, id: String(body.id || '') };
  },

  /* ---------- reporting ---------- */

  stats: function (body, ctx) {
    var items = readTable_('items');
    var byType = {};
    TYPES.forEach(function (t) {
      byType[t] = { total: 0 };
      STATUSES.forEach(function (s) { byType[t][s] = 0; });
    });
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var overdue = 0;
    items.forEach(function (i) {
      if (!byType[i.type]) return;
      if (byType[i.type][i.s] !== undefined) byType[i.type][i.s] += 1;
      byType[i.type].total += 1;
      if (i.s === 'Ongoing' && i.e && String(i.e) < today) overdue += 1;
    });
    var workload = {};
    items.forEach(function (i) {
      [i.f1, i.f2].forEach(function (who) {
        var name = String(who || '').replace(/\s*\(.*?\)/g, '').trim();
        if (!name) return;
        if (!workload[name]) workload[name] = { Ongoing: 0, 'On Hold': 0, Listed: 0, Closed: 0, Done: 0, total: 0 };
        if (workload[name][i.s] !== undefined) workload[name][i.s] += 1;
        workload[name].total += 1;
      });
    });
    return { total: items.length, overdue: overdue, byType: byType, workload: workload,
             people: Object.keys(workload).sort(), generatedAt: nowIso_() };
  },

  exportData: function (body, ctx) {
    assertCan_(ctx.user.role, 'export');          // a Viewer is refused here
    var columns = ['ID', 'Type', 'Title', 'Status', 'Priority', 'Focal-1', 'Focal-2',
                   'Start', 'End', 'Stakeholder', 'Milestones / progress', 'Remarks'];
    var label = { Project: 'Project', Drive: 'Recurring', Task: 'Task' };
    var items = readTable_('items');
    if (body.type) items = items.filter(function (i) { return i.type === body.type; });
    if (body.status) items = items.filter(function (i) { return i.s === body.status; });
    var rows = items.map(function (i) {
      return [i.id, label[i.type] || i.type, i.title, i.s, i.pri, i.f1, i.f2, i.sd, i.e, i.sh,
              String(i.ms || '').split(/\s*(?:\n|\*|•)\s*/).filter(String).join('; '), i.rm];
    });
    audit_('export', ctx.user.email, ctx.user.role, '', rows.length + ' rows');
    return { columns: columns, rows: rows, items: items.map(itemOut_), generatedAt: nowIso_() };
  },

  audit: function (body, ctx) {
    assertCan_(ctx.user.role, 'viewAudit');
    var rows = readTable_('audit');
    var limit = Math.min(Number(body.limit) || 200, 1000);
    return { entries: rows.slice(-limit).reverse(), total: rows.length };
  }
};

/* ===================================================================== */
/* Permissions                                                            */
/* ===================================================================== */

function describeRole_(role) {
  var caps = CAPABILITIES[role] || {};
  return {
    role: role, label: ROLE_LABEL[role] || role, description: ROLE_DESCRIPTION[role] || '',
    writableTypes: WRITABLE_TYPES[role] || [],
    view: !!caps.view, export: !!caps.export, manageUsers: !!caps.manageUsers, viewAudit: !!caps.viewAudit
  };
}

function canWrite_(role, type) {
  return (WRITABLE_TYPES[role] || []).indexOf(type) !== -1;
}

function assertWrite_(role, type) {
  if (TYPES.indexOf(type) === -1) throw fail_(400, 'bad_type', 'Type must be one of: ' + TYPES.join(', '));
  if (canWrite_(role, type)) return true;
  var what = type === 'Drive' ? 'Recurring items' : type + 's';
  throw fail_(403, 'forbidden', 'Your role (' + (ROLE_LABEL[role] || role) + ') cannot edit ' + what);
}

function assertCan_(role, capability) {
  var caps = CAPABILITIES[role] || {};
  if (caps[capability]) return true;
  var what = capability === 'export' ? 'download or print'
    : capability === 'manageUsers' ? 'manage users'
    : capability === 'viewAudit' ? 'read the audit log' : capability;
  throw fail_(403, 'forbidden', 'Your role (' + (ROLE_LABEL[role] || role) + ') cannot ' + what);
}

/* ===================================================================== */
/* Users and sessions                                                     */
/* ===================================================================== */

function normaliseEmail_(value) { return String(value || '').trim().toLowerCase(); }
function docId_(email) { return normaliseEmail_(email).replace(/[^a-z0-9]+/g, '_') || 'x'; }

/* ======================= chat =======================

   One-to-one chat, stored in the Messages tab like any other record.

   There is no socket here: Apps Script answers a request and stops, so it cannot hold a
   connection open. The page already copes with that - without a socket it polls - so chat works
   the same way, a few seconds behind rather than instantly. That is the honest trade for having
   the whole backend be a spreadsheet, and it is what makes chat work at all on this deployment.

   `conversation` is the two addresses sorted and joined, which gives each pair one stable key
   and makes "show me our conversation" a single cheap filter. */

var MESSAGE_MAX_LENGTH = 4000;
var PRESENCE_SECONDS = 90;        /* how long after their last poll somebody counts as online */

function conversationKey_(a, b) {
  return [normaliseEmail_(a), normaliseEmail_(b)].sort().join('|');
}

function messageOut_(row) {
  return {
    id: row.id, from: row.fromEmail, to: row.toEmail,
    body: row.body, at: row.at, readAt: row.readAt || null
  };
}

/* Presence lives in the cache, not the spreadsheet: it is true for ninety seconds at a time, so
   writing a row for it would cost a write on every poll and leave stale rows behind. */
function markSeen_(email) {
  try { CacheService.getScriptCache().put('seen:' + normaliseEmail_(email), '1', PRESENCE_SECONDS); }
  catch (err) { /* presence is a nicety; chat works without it */ }
}

function onlineEmails_(emails) {
  var keys = emails.map(function (e) { return 'seen:' + normaliseEmail_(e); });
  if (!keys.length) return [];
  var found = {};
  try { found = CacheService.getScriptCache().getAll(keys) || {}; } catch (err) { return []; }
  return emails.filter(function (e) { return found['seen:' + normaliseEmail_(e)]; });
}

/**
 * Everything the two of them have said, oldest first.
 *
 * Two messages can carry the same timestamp - the clock here only goes to the millisecond, and
 * a quick exchange lands inside one. Where that happens the row order in the sheet decides, so
 * the conversation reads the same way every time instead of flipping between two orders.
 */
function conversationRows_(a, b) {
  var key = conversationKey_(a, b);
  var rows = [];
  readTable_('messages').forEach(function (row, index) {
    if (row.conversation === key) rows.push({ row: row, index: index });
  });
  rows.sort(function (x, y) {
    if (String(x.row.at) !== String(y.row.at)) return String(x.row.at) < String(y.row.at) ? -1 : 1;
    return x.index - y.index;
  });
  return rows.map(function (entry) { return entry.row; });
}

/** Mark everything the other person sent me as read. Returns how many changed. */
function markConversationRead_(me, other) {
  var mine = normaliseEmail_(me);
  var key = conversationKey_(me, other);
  var rows = readTable_('messages');
  var at = nowIso_();
  var marked = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.conversation !== key || row.toEmail !== mine || String(row.readAt || '')) continue;
    row.readAt = at;
    updateRowAt_('messages', i, row);
    marked += 1;
  }
  return marked;
}

/** One line per colleague: their last message to or from me, and how many I have not read. */
function chatSummary_(me) {
  var mine = normaliseEmail_(me);
  var rows = readTable_('messages');
  var byPerson = {};
  rows.forEach(function (row) {
    if (row.fromEmail !== mine && row.toEmail !== mine) return;
    var other = row.fromEmail === mine ? row.toEmail : row.fromEmail;
    var entry = byPerson[other] || { last: null, unread: 0 };
    /* ">=" rather than ">": on a tie the row further down the sheet is the later one. */
    if (!entry.last || String(row.at) >= String(entry.last.at)) entry.last = row;
    if (row.toEmail === mine && !String(row.readAt || '')) entry.unread += 1;
    byPerson[other] = entry;
  });

  var people = readTable_('users').filter(function (u) { return normaliseEmail_(u.email) !== mine; });
  var contacts = people.map(function (u) {
    var entry = byPerson[normaliseEmail_(u.email)] || { last: null, unread: 0 };
    return {
      email: u.email, name: u.name, role: u.role,
      unread: entry.unread,
      lastAt: entry.last ? entry.last.at : '',
      lastBody: entry.last ? String(entry.last.body).slice(0, 80) : '',
      lastFromMe: entry.last ? entry.last.fromEmail === mine : false
    };
  });
  /* Whoever spoke last comes first, then by name, so the list is useful before anyone has. */
  contacts.sort(function (a, b) {
    if ((b.lastAt || '') !== (a.lastAt || '')) return (b.lastAt || '') < (a.lastAt || '') ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  return contacts;
}

/** Used when an account is removed, so no orphan conversation is left behind. */
function removeMessagesFor_(email) {
  var target = normaliseEmail_(email);
  var rows = readTable_('messages');
  var removed = 0;
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i].fromEmail !== target && rows[i].toEmail !== target) continue;
    deleteRowAt_('messages', i);
    removed += 1;
  }
  return removed;
}

function publicUser_(row) {
  if (!row) return null;
  return {
    id: docId_(row.email), email: row.email, name: row.name, role: row.role,
    externalId: row.externalId || '', at: String(row.createdAt || '').slice(0, 10),
    by: row.createdBy || '', updatedAt: row.updatedAt || '', lastLogin: row.lastLogin || ''
  };
}

function findUser_(email) {
  var target = normaliseEmail_(email);
  var rows = readTable_('users');
  for (var i = 0; i < rows.length; i++) if (normaliseEmail_(rows[i].email) === target) return rows[i];
  return null;
}

function countSuperAdmins_() {
  return readTable_('users').filter(function (u) { return u.role === 'superadmin'; }).length;
}

function createUser_(input) {
  var email = normaliseEmail_(input.email);
  var name = String(input.name || '').trim();
  var role = String(input.role || '');
  var password = String(input.password || '');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail_(400, 'bad_email', 'Enter a valid email address');
  if (!name) throw fail_(400, 'bad_name', 'Enter a name');
  if (ROLES.indexOf(role) === -1) throw fail_(400, 'bad_role', 'Role must be one of: ' + ROLES.join(', '));
  if (password.length < 4) throw fail_(400, 'bad_password', 'The password must be at least 4 characters');
  if (findUser_(email)) throw fail_(409, 'conflict', 'This email already has an account');

  var record = {
    email: email, name: name, role: role, password: hashPassword_(password),
    externalId: String(input.externalId || ''), createdAt: nowIso_(),
    createdBy: input.createdBy || '', updatedAt: '', lastLogin: ''
  };
  appendRow_('users', record);
  return publicUser_(record);
}

function updateUserRow_(email, patch) {
  var target = normaliseEmail_(email);
  var rows = readTable_('users');
  for (var i = 0; i < rows.length; i++) {
    if (normaliseEmail_(rows[i].email) !== target) continue;
    Object.keys(patch).forEach(function (k) { rows[i][k] = patch[k]; });
    updateRowAt_('users', i, rows[i]);
    return rows[i];
  }
  return null;
}

/* ---- password hashing: salted SHA-256, repeated, so a leaked sheet is not a password list ---- */

function hashPassword_(password, salt, rounds) {
  salt = salt || Utilities.base64EncodeWebSafe(randomBytes_(12));
  rounds = rounds || HASH_ROUNDS;
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, 'tracker:' + salt + ':' + password, Utilities.Charset.UTF_8);
  for (var i = 1; i < rounds; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest);
  }
  return 'sha256$' + rounds + '$' + salt + '$' + bytesToHex_(digest);
}

function verifyPassword_(password, stored) {
  var parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'sha256') return false;
  var expected = String(stored);
  var actual = hashPassword_(password, parts[2], Number(parts[1]));
  /* Length-equal comparison that does not stop at the first difference. */
  if (actual.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function randomBytes_(count) {
  var out = [];
  for (var i = 0; i < count; i++) out.push(Math.floor(Math.random() * 256) - 128);
  /* Mix in a true-random element so tokens are not predictable from the clock alone. */
  var seed = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + new Date().getTime() + ':' + Math.random());
  for (var j = 0; j < out.length; j++) out[j] = seed[j % seed.length] ^ out[j];
  return out;
}

function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function sha256Hex_(value) {
  return bytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8));
}

/* ---- sessions ---- */

function createSession_(email, e) {
  var token = Utilities.getUuid().replace(/-/g, '') + bytesToHex_(randomBytes_(16));
  var expires = new Date(new Date().getTime() + SESSION_HOURS * 3600 * 1000);
  appendRow_('sessions', {
    tokenHash: sha256Hex_(token), email: normaliseEmail_(email),
    createdAt: nowIso_(), expiresAt: expires.toISOString(),
    userAgent: ''
  });
  return { token: token, expiresAt: expires.toISOString() };
}

function userForToken_(token) {
  if (!token) return null;
  var hash = sha256Hex_(token);
  var rows = readTable_('sessions');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].tokenHash) !== hash) continue;
    if (new Date(rows[i].expiresAt).getTime() <= new Date().getTime()) {
      deleteRowAt_('sessions', i);
      return null;
    }
    var user = findUser_(rows[i].email);
    return user ? publicUser_(user) : null;
  }
  return null;
}

function destroySession_(token) {
  var hash = sha256Hex_(token);
  var rows = readTable_('sessions');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].tokenHash) === hash) { deleteRowAt_('sessions', i); return true; }
  }
  return false;
}

function destroySessionsFor_(email, keepToken) {
  var target = normaliseEmail_(email);
  var keepHash = keepToken ? sha256Hex_(keepToken) : '';
  var rows = readTable_('sessions');
  var keep = rows.filter(function (r) {
    return normaliseEmail_(r.email) !== target || (keepHash && String(r.tokenHash) === keepHash);
  });
  if (keep.length !== rows.length) writeTable_('sessions', keep);
}

function sessionPayload_(user, session) {
  return {
    user: { email: user.email, name: user.name, role: user.role, id: docId_(user.email) },
    permissions: describeRole_(user.role),
    token: session.token,
    expiresAt: session.expiresAt
  };
}

/* ---- sign-in throttling, kept in script properties ---- */

function throttleLogin_(email) {
  var props = PropertiesService.getScriptProperties();
  var key = 'throttle:' + email;
  var raw = props.getProperty(key);
  var now = new Date().getTime();
  var entry = raw ? JSON.parse(raw) : { count: 0, reset: now + LOGIN_WINDOW_MIN * 60000 };
  if (entry.reset <= now) entry = { count: 0, reset: now + LOGIN_WINDOW_MIN * 60000 };
  entry.count += 1;
  props.setProperty(key, JSON.stringify(entry));
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    var minutes = Math.ceil((entry.reset - now) / 60000);
    throw fail_(429, 'rate_limited', 'Too many sign-in attempts. Try again in ' + minutes + ' minute(s).');
  }
}

function clearThrottle_(email) {
  PropertiesService.getScriptProperties().deleteProperty('throttle:' + email);
}


/* ---- forgotten-password codes ---- */

/** A six-digit code drawn from the same random source as the session tokens. */
function resetCode_() {
  var bytes = randomBytes_(8);
  var n = 0;
  for (var i = 0; i < 4; i++) n = (n * 256 + ((bytes[i] + 256) % 256)) % 1000000;
  return ('00000' + n).slice(-6);
}

/** Only the hash of a code is stored, so the sheet never shows a usable code. */
function hashCode_(email, code) {
  return sha256Hex_('reset:' + normaliseEmail_(email) + ':' + String(code));
}

function findReset_(email) {
  var target = normaliseEmail_(email);
  var rows = readTable_('resets');
  for (var i = 0; i < rows.length; i++) {
    if (normaliseEmail_(rows[i].email) === target) return rows[i];
  }
  return null;
}

function putReset_(email, code) {
  var target = normaliseEmail_(email);
  removeReset_(target);
  appendRow_('resets', {
    email: target,
    codeHash: hashCode_(target, code),
    expiresAt: new Date(new Date().getTime() + RESET_CODE_MINUTES * 60000).toISOString(),
    attempts: 0,
    createdAt: nowIso_()
  });
}

function updateReset_(email, patch) {
  var target = normaliseEmail_(email);
  var rows = readTable_('resets');
  for (var i = 0; i < rows.length; i++) {
    if (normaliseEmail_(rows[i].email) !== target) continue;
    Object.keys(patch).forEach(function (k) { rows[i][k] = patch[k]; });
    updateRowAt_('resets', i, rows[i]);
    return rows[i];
  }
  return null;
}

function removeReset_(email) {
  var target = normaliseEmail_(email);
  var rows = readTable_('resets');
  for (var i = rows.length - 1; i >= 0; i--) {
    if (normaliseEmail_(rows[i].email) === target) deleteRowAt_('resets', i);
  }
}

/** Stop one address from being used to send somebody a flood of emails. */
function throttleReset_(email) {
  var props = PropertiesService.getScriptProperties();
  var key = 'reset:' + email;
  var now = new Date().getTime();
  var raw = props.getProperty(key);
  var entry = raw ? JSON.parse(raw) : { count: 0, reset: now + RESET_REQUEST_WINDOW_MIN * 60000 };
  if (entry.reset <= now) entry = { count: 0, reset: now + RESET_REQUEST_WINDOW_MIN * 60000 };
  entry.count += 1;
  props.setProperty(key, JSON.stringify(entry));
  if (entry.count > RESET_MAX_REQUESTS) {
    throw fail_(429, 'rate_limited',
      'Too many codes requested for that address. Try again in '
      + Math.ceil((entry.reset - now) / 60000) + ' minute(s).');
  }
}

/**
 * Send the code with Gmail, through the account that owns this script.
 * Free, and nothing to configure: a consumer account may send about 100 emails a day,
 * a Workspace account about 1500. MailApp.getRemainingDailyQuota() shows what is left.
 */
function sendResetEmail_(user, code) {
  var subject = 'Your Task and Project Tracker password code: ' + code;
  var plain = [
    'Hello ' + user.name + ',',
    '',
    'Your password reset code is: ' + code,
    '',
    'Type it on the tracker sign-in page within ' + RESET_CODE_MINUTES + ' minutes, together with',
    'the new password you want to use.',
    '',
    'If you did not ask for this, ignore this email. Your current password still works.',
    '',
    'Infrastructure & Support, Technology, Microfinance'
  ].join('\n');

  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">'
    + '<p>Hello ' + escapeHtml_(user.name) + ',</p>'
    + '<p>Your password reset code is:</p>'
    + '<p style="font-size:30px;font-weight:bold;letter-spacing:8px;color:#ec008c;margin:18px 0">'
    + code + '</p>'
    + '<p>Type it on the tracker sign-in page within <b>' + RESET_CODE_MINUTES + ' minutes</b>, '
    + 'together with the new password you want to use.</p>'
    + '<p style="color:#64748b;font-size:13px">If you did not ask for this, ignore this email. '
    + 'Your current password still works.</p>'
    + '<hr style="border:0;border-top:1px solid #e5e9f2;margin:18px 0">'
    + '<p style="color:#64748b;font-size:12px">Infrastructure &amp; Support · Technology · Microfinance</p>'
    + '</div>';

  try {
    MailApp.sendEmail({
      to: user.email,
      subject: subject,
      body: plain,
      htmlBody: html,
      name: 'Task and Project Tracker'
    });
    return true;
  } catch (err) {
    Logger.log('Could not send the reset email to %s: %s', user.email, err.message);
    return false;
  }
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ===================================================================== */
/* Items                                                                  */
/* ===================================================================== */

function itemOut_(row) {
  return {
    id: row.id, type: row.type, title: row.title, s: row.s, pri: row.pri,
    f1: row.f1, f2: row.f2, sd: row.sd, e: row.e, sh: row.sh, ms: row.ms, rm: row.rm,
    createdAt: row.createdAt, createdBy: row.createdBy,
    updatedAt: row.updatedAt, updatedBy: row.updatedBy, role: row.role || ''
  };
}

function cleanItem_(input, partial) {
  var out = {};
  var has = function (k) { return Object.prototype.hasOwnProperty.call(input, k); };
  var text = function (v, max) { return String(v === undefined || v === null ? '' : v).trim().slice(0, max); };

  if (!partial || has('type')) {
    var type = text(input.type, 20);
    if (TYPES.indexOf(type) === -1) throw fail_(400, 'bad_type', 'Type must be one of: ' + TYPES.join(', '));
    out.type = type;
  }
  if (!partial || has('title')) {
    var title = text(input.title, 300);
    if (!title) throw fail_(400, 'bad_title', 'A name or title is required');
    out.title = title;
  }
  if (!partial || has('f1')) {
    var f1 = text(input.f1, 120);
    if (!f1) throw fail_(400, 'bad_focal', 'Focal-1 (lead) is required');
    out.f1 = f1;
  }
  if (!partial || has('s')) {
    var s = text(input.s, 20) || 'Ongoing';
    if (STATUSES.indexOf(s) === -1) throw fail_(400, 'bad_status', 'Status must be one of: ' + STATUSES.join(', '));
    out.s = s;
  }
  if (!partial || has('pri')) {
    var pri = text(input.pri, 10) || 'Mid';
    if (PRIORITIES.indexOf(pri) === -1) throw fail_(400, 'bad_priority', 'Priority must be one of: ' + PRIORITIES.join(', '));
    out.pri = pri;
  }
  [['f2', 120], ['sh', 200], ['rm', 2000], ['ms', 8000]].forEach(function (pair) {
    if (!partial || has(pair[0])) out[pair[0]] = text(input[pair[0]], pair[1]);
  });
  ['sd', 'e'].forEach(function (key) {
    if (!partial || has(key)) {
      var v = text(input[key], 10);
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw fail_(400, 'bad_date', (key === 'sd' ? 'Start' : 'End') + ' date must look like 2026-10-14');
      }
      out[key] = v;
    }
  });
  return out;
}

function nextId_(type, rows) {
  var prefix = PREFIX[type] + '-';
  var highest = 0;
  (rows || readTable_('items')).forEach(function (r) {
    var id = String(r.id || '');
    if (id.indexOf(prefix) !== 0) return;
    var n = parseInt(id.slice(prefix.length), 10);
    if (!isNaN(n) && n > highest) highest = n;
  });
  return prefix + (highest + 1);
}

function removeRequest_(id) {
  var rows = readTable_('requests');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) { deleteRowAt_('requests', i); return true; }
  }
  return false;
}

function audit_(action, actor, role, target, detail) {
  try {
    appendRow_('audit', {
      at: nowIso_(), actor: actor || '', role: role || '',
      action: action, target: target || '', detail: detail || ''
    });
  } catch (err) { /* the audit log must never break the action that triggered it */ }
}

/* ===================================================================== */
/* Spreadsheet helpers                                                    */
/* ===================================================================== */

function spreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  var active = null;
  try {
    active = SpreadsheetApp.getActive();
  } catch (err) {
    /* Almost always one of two things, and the raw message says neither. */
    throw fail_(500, 'no_permission',
      'This script may not open the spreadsheet yet: ' + err.message +
      '  Run setupTracker from the editor and accept the permission prompt. If no prompt appears,' +
      ' remove the project under myaccount.google.com → Data & privacy → Third-party access, then run it again.');
  }
  if (active) return active;
  throw fail_(500, 'no_sheet',
    'No spreadsheet is attached to this script. Either open the script from inside the sheet' +
    ' (Extensions → Apps Script), or set a SHEET_ID script property to the id in the sheet URL.');
}

/* ======================= the workbook this tracker lives in =======================

   This script is a guest in a workbook people already keep by hand: eighteen tabs, hundreds
   of rows, formulas, merged headings, dropdowns. Two rules follow from that, and the code
   below exists to keep them.

     1. Nothing that was already here is ever deleted, cleared or reformatted. Not a row, not
        a column, not a header. The script writes only where it is told to, and only rows it
        created itself can be removed by it.

     2. Each kind of item lives where the team already keeps that kind, in that tab's own
        columns and its own words:

          Projects and drives  ->  "IS Project & Drive"    (Type says which)
          Tasks                ->  "Individual Task List"

        Both tabs are read in full, so everything the team has typed shows in the page, and a
        new item goes to the tab its kind belongs in.

   Everything the backend needs for itself - accounts, sessions, chat, the audit trail, and
   the bookkeeping that says which rows it owns - goes in its own hidden tabs, named so they
   are obviously the software's and never mistaken for the real work. */

var ITEM_SHEET_DEFAULT = 'IS Project & Drive';
var TASK_SHEET_DEFAULT = 'Individual Task List';

function scriptProperty_(name) {
  try { return PropertiesService.getScriptProperties().getProperty(name) || ''; } catch (err) { return ''; }
}

/** The tab holding projects and drives. Override with the ITEM_SHEET script property. */
function itemSheetName_() { return scriptProperty_('ITEM_SHEET') || ITEM_SHEET_DEFAULT; }

/** The tab holding tasks. Override with the TASK_SHEET script property. */
function taskSheetName_() { return scriptProperty_('TASK_SHEET') || TASK_SHEET_DEFAULT; }

/**
 * How a row the team marked "Drive" shows in the page: as a drive (the page calls them
 * Recurring), or under Tasks. The default keeps the team's own word. Set the script property
 * DRIVE_ROWS_SHOW_AS to Task to list them with the tasks instead; they are still written back
 * to their own tab as drives either way.
 */
function driveRowsShowAs_() {
  return /^task$/i.test(scriptProperty_('DRIVE_ROWS_SHOW_AS')) ? 'Task' : 'Drive';
}

/* The fifteen columns of each tab, in the team's order. The script fills the ones it manages
   and leaves the rest exactly as it found them. */
var ITEM_COL = {
  id: 1, type: 2, impact: 3, fy: 4, title: 5, activity: 6, f1: 7, f2: 8,
  start: 9, end: 10, duration: 11, status: 12, stakeholder: 13, budget: 14, remarks: 15
};
var ITEM_WIDTH = 15;

var TASK_COL = {
  sn: 1, ref: 2, assigned: 3, priority: 4, fy: 5, title: 6, milestones: 7,
  start: 8, end: 9, duration: 10, status: 11, requester: 12, vendor: 13, f2: 14, remarks: 15
};
var TASK_WIDTH = 15;

function namedSheet_(name, holds, property) {
  var sh = spreadsheet_().getSheetByName(name);
  if (!sh) {
    throw new Error('The tab "' + name + '" (' + holds + ') is not in this spreadsheet. Check the '
      + 'name, or set the ' + property + ' script property to the tab they should go in.');
  }
  return sh;
}
function itemSheet_() { return namedSheet_(itemSheetName_(), 'projects and drives', 'ITEM_SHEET'); }
function taskSheet_() { return namedSheet_(taskSheetName_(), 'tasks', 'TASK_SHEET'); }

/* ---------- reading their values without assuming how they were typed ---------- */

/** A cell holding a day, whatever shape it is in, as yyyy-MM-dd. Empty when it is not a date. */
function toIsoDay_(value) {
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    try { return Utilities.formatDate(value, timeZone_(), 'yyyy-MM-dd'); } catch (err) { return ''; }
  }
  var text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  var months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  /* 12-Jun-2024, 1 Sep 2024, 2-July-2025, 26 Feb 2025 */
  var named = text.match(/^(\d{1,2})[-\s.]([A-Za-z]{3,9})[-\s.](\d{2,4})$/);
  if (named) {
    var m = months[named[2].slice(0, 3).toLowerCase()];
    if (m) {
      var y = Number(named[3]);
      if (y < 100) y += 2000;
      return y + '-' + pad(m) + '-' + pad(Number(named[1]));
    }
  }
  /* 01.07.2024 and 01/07/2024, read day first, the way this workbook writes them */
  var numeric = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (numeric) {
    var yy = Number(numeric[3]);
    if (yy < 100) yy += 2000;
    return yy + '-' + pad(Number(numeric[2])) + '-' + pad(Number(numeric[1]));
  }
  return '';
}

/** A day back out as a real date, anchored at midday so no timezone can shift it. */
function fromIsoDay_(iso) {
  var text = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  var parts = text.split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
}

function daysBetween_(startIso, endIso) {
  if (!startIso || !endIso) return '';
  var a = fromIsoDay_(startIso), b = fromIsoDay_(endIso);
  if (!a || !b) return '';
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * How the dates in a column are stored, so a new row is written the same way.
 *
 * A column people have typed into can hold real dates or plain text that reads like one. Write
 * a Date into a column of text and it shows up in a different format from every row above it;
 * write text into a column of dates and their sorting and formulas stop seeing a date. So the
 * column is sampled, and whatever is already there is what gets written.
 */
function dateStyle_(sh, column) {
  var last = Math.min(sh.getLastRow(), 60);
  for (var row = 2; row <= last; row++) {
    var value = sh.getRange(row, column).getValue();
    if (value instanceof Date) return 'date';
    if (String(value || '').trim()) return 'text';
  }
  return 'date';
}

/** A day written the way the column already writes them. */
function dayForColumn_(sh, column, iso) {
  if (!iso) return '';
  var when = fromIsoDay_(iso);
  if (!when) return '';
  if (dateStyle_(sh, column) === 'date') return when;
  try { return Utilities.formatDate(when, timeZone_(), 'd-MMM-yyyy'); }
  catch (err) { return iso; }
}

/* The vocabularies differ a little between the page and a tab people type into by hand, so
   both are accepted on the way in. Nothing is corrected in place: a cell is only rewritten
   when somebody edits that item in the page. */
function readType_(value) {
  var t = String(value || '').trim().toLowerCase();
  if (t.indexOf('drive') === 0 || t.indexOf('recurring') === 0) return 'Drive';
  if (t.indexOf('task') === 0) return 'Task';
  return 'Project';
}

function readStatus_(value) {
  var s = String(value || '').trim().toLowerCase();
  if (!s) return 'Listed';
  if (s.indexOf('on-going') === 0 || s.indexOf('ongoing') === 0 || s.indexOf('on going') === 0) return 'Ongoing';
  if (s.indexOf('done') === 0 || s.indexOf('complete') === 0) return 'Done';
  if (s.indexOf('hold') !== -1) return 'On Hold';
  if (s.indexOf('clos') === 0 || s.indexOf('cancel') === 0) return 'Closed';
  return 'Listed';
}

function readPriority_(value) {
  var p = String(value || '').trim().toLowerCase();
  if (p.indexOf('high') === 0 || p === '1') return 'High';
  if (p.indexOf('low') === 0 || p === '3') return 'Low';
  return 'Mid';
}

/* ---------- fitting what the page says into what the dropdowns allow ----------

   The Type column of the projects tab is a dropdown with two choices, Drive and Project.
   Google does not quietly ignore a third value - it refuses the whole write. So the script
   asks each column what its dropdown allows and writes in those words; where nothing fits,
   the cell is left as it was rather than filled with something untrue. */

function allowedValues_(sh, column) {
  try {
    var rule = sh.getRange(2, column).getDataValidation();
    if (!rule) return null;
    if (String(rule.getCriteriaType()) !== 'VALUE_IN_LIST') return null;
    var values = rule.getCriteriaValues()[0];
    if (!values || !values.length) return null;
    return values.map(function (v) { return String(v); });
  } catch (err) { return null; }
}

/** The spelling a column will accept for a value, trying each preference in turn; null when none fit. */
function fitToList_(preferences, allowed) {
  if (!allowed) return preferences[0];
  for (var i = 0; i < preferences.length; i++) {
    var want = String(preferences[i]).toLowerCase().replace(/[^a-z]/g, '');
    for (var j = 0; j < allowed.length; j++) {
      if (String(allowed[j]).toLowerCase().replace(/[^a-z]/g, '') === want) return allowed[j];
    }
  }
  return null;
}

function sheetType_(type) {
  /* A task has no entry in this dropdown, so one that ends up in this tab is filed as a drive -
     the nearest thing it offers. Its own tab is where tasks normally go. */
  var order = type === 'Project' ? ['Project', 'Drive'] : ['Drive', 'Project'];
  return fitToList_(order, allowedValues_(itemSheet_(), ITEM_COL.type));
}

function sheetPriority_(sh, column, pri) {
  var order = pri === 'High' ? ['High', 'Medium', 'Mid', '1']
    : pri === 'Low' ? ['Low', 'Medium', 'Mid', '3']
    : ['Mid', 'Medium', 'Moderate', 'Normal', '2'];
  return fitToList_(order, allowedValues_(sh, column));
}

function sheetStatus_(sh, column, status) {
  var orders = {
    'Ongoing': ['Ongoing', 'On-Going', 'On Going', 'Running', 'In Progress'],
    'Done': ['Done', 'Completed', 'Complete'],
    'On Hold': ['On Hold', 'Hold', 'On-Hold'],
    'Listed': ['Listed', 'Planned', 'Pending', 'To Do'],
    'Closed': ['Closed', 'Cancelled', 'Canceled']
  };
  return fitToList_(orders[status] || [status], allowedValues_(sh, column));
}

/* ---------- the bookkeeping the script keeps about itself ----------

   Who created a row, when, with which role, what the page calls it, and whether this script
   put it there at all. None of it belongs in the team's columns, so it lives in a hidden tab
   of its own and their sheets gain not a single column. */

/** id -> {type, role, createdAt, createdBy, updatedAt, updatedBy, owned} */
function itemMeta_() {
  var map = {};
  readTable_('itemmeta').forEach(function (row) {
    if (row.id) map[String(row.id)] = row;
  });
  return map;
}

function saveItemMeta_(id, patch) {
  var rows = readTable_('itemmeta');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) !== String(id)) continue;
    var merged = rows[i];
    Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
    updateRowAt_('itemmeta', i, merged);
    return merged;
  }
  var fresh = { id: id, type: '', role: '', createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', owned: '' };
  Object.keys(patch).forEach(function (k) { fresh[k] = patch[k]; });
  appendRow_('itemmeta', fresh);
  return fresh;
}

/**
 * Bookkeeping must never undo a save. The row is already in the team's tab by the time this
 * runs; if the note about it cannot be written, the save still happened, and telling the
 * person it failed would be untrue. So it is tried twice and then logged, not thrown.
 */
function recordMeta_(id, patch) {
  var last = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    try { saveItemMeta_(id, patch); return true; } catch (err) { last = err; }
  }
  Logger.log('The bookkeeping for %s could not be written: %s', id, last && last.message);
  return false;
}

function dropItemMeta_(id) {
  var rows = readTable_('itemmeta');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) { deleteRowAt_('itemmeta', i); return true; }
  }
  return false;
}

/* ---------- items, read from both tabs ---------- */

function readItems_() {
  var meta = itemMeta_();
  return readProjectRows_(meta).concat(readTaskRows_(meta));
}

function readProjectRows_(meta) {
  var sh = itemSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, ITEM_WIDTH).getValues();
  var showDrivesAs = driveRowsShowAs_();
  var out = [];

  values.forEach(function (line, index) {
    var id = String(line[ITEM_COL.id - 1] || '').trim();
    var title = String(line[ITEM_COL.title - 1] || '').trim();
    /* A line with neither an id nor a title is a spacer, not a record. */
    if (!id && !title) return;

    var mine = meta[id] || {};
    var kind = readType_(line[ITEM_COL.type - 1]);
    /* The page's own record of what it is wins over the two words the cell can hold. */
    if (mine.type === 'Task' || (!mine.type && id.indexOf('T-') === 0)) kind = 'Task';
    else if (kind === 'Drive' && showDrivesAs === 'Task') kind = 'Task';

    out.push({
      id: id, type: kind, title: title,
      s: readStatus_(line[ITEM_COL.status - 1]),
      pri: readPriority_(line[ITEM_COL.impact - 1]),
      f1: String(line[ITEM_COL.f1 - 1] || '').trim(),
      f2: String(line[ITEM_COL.f2 - 1] || '').trim(),
      sd: toIsoDay_(line[ITEM_COL.start - 1]),
      e: toIsoDay_(line[ITEM_COL.end - 1]),
      sh: String(line[ITEM_COL.stakeholder - 1] || '').trim(),
      ms: String(line[ITEM_COL.activity - 1] || '').trim(),
      rm: String(line[ITEM_COL.remarks - 1] || '').trim(),
      createdAt: mine.createdAt || '', createdBy: mine.createdBy || '',
      updatedAt: mine.updatedAt || '', updatedBy: mine.updatedBy || '',
      role: mine.role || '',
      __sheet: 'items', __row: index + 2,
      /* Rows that were here before this script are shown and can be edited, never deleted. */
      __owned: String(mine.owned || '') === 'yes'
    });
  });
  return out;
}

/**
 * The tasks tab has no id column of its own: a serial number, and a "Ref. ID" that is mostly
 * blank. So a task's id is T- plus its serial number, which is what the page shows and what
 * is written into Ref. ID for the rows this script creates. A line whose serial is missing or
 * repeated gets an id from its row instead, so nothing is left out and nothing collides.
 */
function readTaskRows_(meta) {
  var sh = taskSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, TASK_WIDTH).getValues();
  var seen = {};
  var out = [];

  values.forEach(function (line, index) {
    var sn = String(line[TASK_COL.sn - 1] === null || line[TASK_COL.sn - 1] === undefined ? '' : line[TASK_COL.sn - 1]).trim();
    var ref = String(line[TASK_COL.ref - 1] || '').trim();
    var title = String(line[TASK_COL.title - 1] || '').trim();
    if (!sn && !ref && !title) return;

    var row = index + 2;
    var id = /^T-\d+$/.test(ref) ? ref : (/^\d+$/.test(sn) && Number(sn) > 0 ? 'T-' + Number(sn) : 'T-r' + row);
    if (seen[id]) id = 'T-r' + row;
    seen[id] = true;

    var mine = meta[id] || {};
    out.push({
      id: id, type: 'Task', title: title,
      s: readStatus_(line[TASK_COL.status - 1]),
      pri: readPriority_(line[TASK_COL.priority - 1]),
      f1: String(line[TASK_COL.assigned - 1] || '').trim(),
      f2: String(line[TASK_COL.f2 - 1] || '').trim(),
      sd: toIsoDay_(line[TASK_COL.start - 1]),
      e: toIsoDay_(line[TASK_COL.end - 1]),
      sh: String(line[TASK_COL.requester - 1] || '').trim(),
      ms: String(line[TASK_COL.milestones - 1] || '').trim(),
      rm: String(line[TASK_COL.remarks - 1] || '').trim(),
      createdAt: mine.createdAt || '', createdBy: mine.createdBy || '',
      updatedAt: mine.updatedAt || '', updatedBy: mine.updatedBy || '',
      role: mine.role || '',
      __sheet: 'tasks', __row: row,
      __owned: String(mine.owned || '') === 'yes'
    });
  });
  return out;
}

/* ---------- writing, in each tab's own columns ---------- */

/** Write into the projects tab, leaving every column the script does not manage as it was. */
function writeProjectRow_(rowNumber, item) {
  var sh = itemSheet_();
  var range = sh.getRange(rowNumber, 1, 1, ITEM_WIDTH);
  var line = range.getValues()[0];
  var set = function (col, value) { line[col - 1] = value; };
  var keep = function (col, value) { if (value !== null && value !== undefined) set(col, value); };

  set(ITEM_COL.id, item.id);
  keep(ITEM_COL.type, sheetType_(item.type));
  keep(ITEM_COL.impact, item.pri ? sheetPriority_(sh, ITEM_COL.impact, item.pri) : '');
  set(ITEM_COL.title, item.title || '');
  set(ITEM_COL.activity, item.ms || '');
  set(ITEM_COL.f1, item.f1 || '');
  set(ITEM_COL.f2, item.f2 || '');
  set(ITEM_COL.start, dayForColumn_(sh, ITEM_COL.start, item.sd));
  set(ITEM_COL.end, dayForColumn_(sh, ITEM_COL.end, item.e));
  set(ITEM_COL.duration, daysBetween_(item.sd, item.e));
  keep(ITEM_COL.status, item.s ? sheetStatus_(sh, ITEM_COL.status, item.s) : '');
  set(ITEM_COL.stakeholder, item.sh || '');
  set(ITEM_COL.remarks, item.rm || '');
  /* FY is filled only when empty, so a year somebody chose is never overruled. */
  if (!String(line[ITEM_COL.fy - 1] || '').trim() && item.sd) set(ITEM_COL.fy, item.sd.slice(0, 4));

  range.setValues([line]);
}

/** Write into the tasks tab. The serial number and Ref. ID are given once, on creation. */
function writeTaskRow_(rowNumber, item, isNew) {
  var sh = taskSheet_();
  var range = sh.getRange(rowNumber, 1, 1, TASK_WIDTH);
  var line = range.getValues()[0];
  var set = function (col, value) { line[col - 1] = value; };
  var keep = function (col, value) { if (value !== null && value !== undefined) set(col, value); };

  if (isNew) {
    var number = parseInt(String(item.id).replace(/^T-/, ''), 10);
    set(TASK_COL.sn, isNaN(number) ? '' : number);
    set(TASK_COL.ref, item.id);
  }
  set(TASK_COL.assigned, item.f1 || '');
  keep(TASK_COL.priority, item.pri ? sheetPriority_(sh, TASK_COL.priority, item.pri) : '');
  set(TASK_COL.title, item.title || '');
  set(TASK_COL.milestones, item.ms || '');
  set(TASK_COL.start, dayForColumn_(sh, TASK_COL.start, item.sd));
  set(TASK_COL.end, dayForColumn_(sh, TASK_COL.end, item.e));
  set(TASK_COL.duration, daysBetween_(item.sd, item.e));
  keep(TASK_COL.status, item.s ? sheetStatus_(sh, TASK_COL.status, item.s) : '');
  set(TASK_COL.requester, item.sh || '');
  set(TASK_COL.f2, item.f2 || '');
  set(TASK_COL.remarks, item.rm || '');
  if (!String(line[TASK_COL.fy - 1] || '').trim() && item.sd) set(TASK_COL.fy, item.sd.slice(0, 4));

  range.setValues([line]);
}

function sheetFor_(item) {
  var which = item.__sheet || (item.type === 'Task' ? 'tasks' : 'items');
  return which === 'tasks' ? taskSheet_() : itemSheet_();
}

function appendItem_(item) {
  var toTasks = item.type === 'Task';
  var sh = toTasks ? taskSheet_() : itemSheet_();
  var row = sh.getLastRow() + 1;

  /* A write can still be refused - a dropdown nobody told us about, a protected range - and
     Google fills the cells up to the one it objects to before throwing. That leaves a stray
     line carrying nothing but an id. Clearing up after a failed append is this function's
     job, not the next person's. */
  try {
    if (toTasks) writeTaskRow_(row, item, true); else writeProjectRow_(row, item);
  } catch (err) {
    try { if (sh.getLastRow() >= row) sh.deleteRow(row); } catch (ignored) {}
    throw err;
  }

  recordMeta_(item.id, {
    type: item.type, role: item.role || '',
    createdAt: item.createdAt || nowIso_(), createdBy: item.createdBy || '',
    updatedAt: '', updatedBy: '', owned: 'yes'
  });
  return row;
}

function updateItem_(item) {
  var where = item.__sheet, row = item.__row;
  if (!row || !where) {
    var all = readItems_();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === item.id) { row = all[i].__row; where = all[i].__sheet; break; }
    }
  }
  if (!row) throw fail_(404, 'not_found', 'That row is no longer in the spreadsheet');
  if (where === 'tasks') writeTaskRow_(row, item, false); else writeProjectRow_(row, item);
  recordMeta_(item.id, {
    type: item.type, role: item.role || '',
    updatedAt: item.updatedAt || nowIso_(), updatedBy: item.updatedBy || ''
  });
}

/** A line carrying an id and nothing else is wreckage from a refused write, never real work. */
function isStrayRow_(item) {
  if (item.title) return false;
  var sh = sheetFor_(item);
  var width = item.__sheet === 'tasks' ? TASK_WIDTH : ITEM_WIDTH;
  var idColumns = item.__sheet === 'tasks' ? [TASK_COL.sn, TASK_COL.ref] : [ITEM_COL.id];
  var line = sh.getRange(item.__row, 1, 1, width).getValues()[0];
  for (var i = 0; i < line.length; i++) {
    if (idColumns.indexOf(i + 1) !== -1) continue;
    if (String(line[i] === null || line[i] === undefined ? '' : line[i]).trim()) return false;
  }
  return true;
}

/**
 * Remove a row - but only one this script put there.
 *
 * Everything that was in the workbook beforehand belongs to the people who keep it, and a
 * delete in the page must never reach it. Those rows are shown, and can be edited, but they
 * can only be removed in the spreadsheet itself.
 */
function deleteItem_(item) {
  if (!item.__owned && !isStrayRow_(item)) {
    throw fail_(400, 'not_ours', 'That row was already in the spreadsheet, so this app did not '
      + 'create it and will not delete it. Remove it in the sheet if you really mean to.');
  }
  sheetFor_(item).deleteRow(item.__row);
  dropItemMeta_(item.id);
}

/**
 * Bring one of the script's own tabs to the layout this version expects.
 *
 * Columns get added between versions - the meta tab gained "type" - and the generic readers
 * and writers below go by position. A tab laid out by an older version would then be read
 * one column off and written one column off, silently. So the header row is compared, and
 * when it differs the rows are moved by column NAME into the current layout, once. Only the
 * script's own tabs ever come through here; the team's tabs are never touched.
 */
function conformTable_(sh, spec) {
  var width = Math.max(sh.getLastColumn(), spec.headers.length, 1);
  var header = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var same = spec.headers.every(function (h, i) { return header[i] === h; })
    && header.slice(spec.headers.length).every(function (h) { return !h; });
  if (same) return false;

  var last = sh.getLastRow();
  var moved = [];
  if (last >= 2) {
    var at = {};
    header.forEach(function (h, i) { if (h && at[h] === undefined) at[h] = i; });
    sh.getRange(2, 1, last - 1, width).getValues().forEach(function (line) {
      if (!line.some(function (v) { return String(v === null || v === undefined ? '' : v).length; })) return;
      moved.push(spec.headers.map(function (h) {
        var i = at[h];
        return i === undefined || line[i] === null || line[i] === undefined ? '' : line[i];
      }));
    });
  }
  if (last >= 1) sh.getRange(1, 1, last, width).clearContent();
  sh.getRange(1, 1, 1, spec.headers.length).setValues([spec.headers]).setFontWeight('bold');
  if (moved.length) sh.getRange(2, 1, moved.length, spec.headers.length).setValues(moved);
  return true;
}

function sheet_(key) {
  var spec = SHEETS[key];
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(spec.name);
  if (sh) { conformTable_(sh, spec); return sh; }
  if (!sh) {
    sh = ss.insertSheet(spec.name);
    sh.getRange(1, 1, 1, spec.headers.length).setValues([spec.headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    /* Out of the way: this is the software's plumbing, not anybody's working tab. */
    try { sh.hideSheet(); } catch (err) {}
    spec.headers.forEach(function (header, i) {
      if (DAY_COLUMNS[header]) {
        try { sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@'); }
        catch (err) {}
      }
    });
  }
  return sh;
}

/** Read a whole tab as an array of objects keyed by the header row. */
function readTable_(key) {
  /* Items are not a tab of this script's own making - they are read out of the team's tab,
     in the team's columns. Everything else is a plain table. */
  if (key === 'items') return readItems_();
  var spec = SHEETS[key];
  var sh = sheet_(key);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, spec.headers.length).getValues();
  return values.map(function (row) {
    var object = {};
    spec.headers.forEach(function (header, i) {
      var v = row[i];
      object[header] = (v instanceof Date) ? dateOut_(header, v)
        : (v === null || v === undefined ? '' : String(v));
    });
    return object;
  }).filter(function (o) {
    /* Skip blank lines left behind by manual edits. */
    return Object.keys(o).some(function (k) { return String(o[k]).length; });
  });
}

/* Columns the page sends as a plain day, "2026-10-01", with no time and no timezone. */
var DAY_COLUMNS = { sd: true, e: true };

/** The spreadsheet's own timezone – the one Sheets uses when it parses a typed date. */
function timeZone_() {
  try { return spreadsheet_().getSpreadsheetTimeZone(); }
  catch (err) { return Session.getScriptTimeZone(); }
}

/**
 * A cell that came back as a Date, turned into the text the page expects.
 *
 * Sheets treats a typed "2026-10-01" as a date and hands it back as midnight local time, so
 * east of Greenwich toISOString() reports the evening BEFORE – the start date of a project
 * read back a day early. Formatting in the spreadsheet's timezone undoes exactly that, and it
 * also tidies up dates somebody typed into the sheet by hand.
 */
function dateOut_(header, value) {
  if (DAY_COLUMNS[header]) {
    try { return Utilities.formatDate(value, timeZone_(), 'yyyy-MM-dd'); }
    catch (err) { /* fall through to the timestamp form */ }
  }
  return value.toISOString();
}

/* Writing "2026-10-01" into a cell is the same as typing it, so Sheets would convert it to a
   date and the round trip above would be needed on every read. Keeping those columns as plain
   text means the sheet shows, exports and sorts the day exactly as it was entered. */
function markDayColumnsAsText_(key) {
  var spec = SHEETS[key];
  var sh = sheet_(key);
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  spec.headers.forEach(function (header, i) {
    if (!DAY_COLUMNS[header]) return;
    try { sh.getRange(2, i + 1, rows, 1).setNumberFormat('@'); } catch (err) {}
  });
}

/**
 * Bring a tab's header row up to date with the spec above.
 *
 * Columns are only ever added at the end, so rewriting row 1 cannot move anybody's data: it
 * names the column that a newer version of this file writes into. Without it, a spreadsheet
 * made by an earlier version would keep a nameless column and the role views would filter on
 * an empty header.
 */
function ensureHeaders_(key) {
  return conformTable_(sheet_(key), SHEETS[key]);
}

/**
 * Fill in the role of whoever created each item that does not have one yet, by looking their
 * address up in the accounts tab.
 *
 * This writes to the script's own meta tab, never to the team's. A row created before the
 * roles were recorded simply has no role, and would be missing from every role view until
 * this fills it in.
 */
function fillInItemRoles_() {
  var roleOf = {};
  readTable_('users').forEach(function (u) { roleOf[normaliseEmail_(u.email)] = u.role; });

  var filled = 0;
  readTable_('itemmeta').forEach(function (row, index) {
    if (String(row.role || '')) return;
    var role = roleOf[normaliseEmail_(row.createdBy)] || '';
    if (!role) return;
    row.role = role;
    updateRowAt_('itemmeta', index, row);
    filled += 1;
  });
  return filled;
}
function rowValues_(key, object) {
  return SHEETS[key].headers.map(function (h) {
    var v = object[h];
    return v === undefined || v === null ? '' : v;
  });
}

function appendRow_(key, object) {
  if (key === 'items') { appendItem_(object); return; }
  sheet_(key).appendRow(rowValues_(key, object));
}

function updateRowAt_(key, index, object) {
  if (key === 'items') { updateItem_(object); return; }
  var spec = SHEETS[key];
  sheet_(key).getRange(index + 2, 1, 1, spec.headers.length).setValues([rowValues_(key, object)]);
}

function deleteRowAt_(key, index) {
  if (key === 'items') {
    /* The caller found this row in the list it just read, so read it the same way again and
       let the adapter decide whether this script is allowed to remove it. */
    var rows = readItems_();
    if (!rows[index]) throw fail_(404, 'not_found', 'That row is no longer in the spreadsheet');
    deleteItem_(rows[index]);
    return;
  }
  sheet_(key).deleteRow(index + 2);
}

function writeTable_(key, rows) {
  var spec = SHEETS[key];
  var sh = sheet_(key);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, spec.headers.length).clearContent();
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, spec.headers.length)
    .setValues(rows.map(function (r) { return rowValues_(key, r); }));
}

/** Serialise writes so two people saving at the same moment cannot corrupt a row. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nowIso_() { return new Date().toISOString(); }
