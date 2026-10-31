/* gsheet.js – talks to the Google Apps Script backend, where the database is a Google Sheet.

   It offers the Presenter exactly the same thing js/api.js does (and reports the same
   kind: 'api'), so every screen, role check and dialog works unchanged. Switching between the
   Node.js server and the Google Sheet is a matter of which URL the page is given.

   Turn it on by setting the deployment URL before this script loads:

       <script>window.GAS_URL='https://script.google.com/macros/s/..../exec';</script>
       <script src="js/gsheet.js"></script>

   Two differences from the Node backend, both forced by how Apps Script works:
     · Requests are POSTs with Content-Type text/plain. Browsers treat that as a "simple"
       request, so there is no CORS preflight – which Apps Script cannot answer.
     · There are no cookies across origins, so the session token is kept in this browser's
       storage and sent in the body of each call.

   And one thing it does because Apps Script is slow - three to six seconds for every request,
   whatever it asks:

     · The last data loaded is kept in this browser. The next visit draws from it at once and
       brings it up to date in the background, instead of waiting through several round trips
       with nothing on screen.
     · A create, edit or delete is applied here immediately and sent behind it, in order. The
       queue of changes not yet confirmed is kept in this browser too, so closing the tab or
       losing the connection does not lose them; they go out when the sheet can be reached. A
       change the sheet refuses is undone, and the person is told why.

   Part of the MVP split: js/model.js · js/view.js · js/export.js · js/gsheet.js · js/presenter.js */

(function (global) {
  'use strict';

  var TOKEN_KEY = 'tracker.gas.token';
  var CACHE_PREFIX = 'tracker.gas.cache:';
  var OUTBOX_PREFIX = 'tracker.gas.outbox:';
  var CACHE_VERSION = 2;
  var CACHE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;   // older than a fortnight: start fresh

  function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function writeToken(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function storageGet(key) {
    try { var text = localStorage.getItem(key); return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function storageDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  /* A start or end date is a plain day, "2026-10-01". A spreadsheet made before the backend
     kept those columns as text stores them as real dates instead, and hands them back as the
     local midnight – which is the evening before in UTC, so the day read back an hour-zone to
     the east was one short. Reading the day off the viewer's own clock puts it right without
     anybody having to touch the spreadsheet. */
  function asDay(value) {
    var text = String(value === undefined || value === null ? '' : value);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return text;
    var d = new Date(text);
    if (isNaN(d.getTime())) return text;
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function itemIn(item) {
    if (!item || typeof item !== 'object') return item;
    if (item.sd !== undefined) item.sd = asDay(item.sd);
    if (item.e !== undefined) item.e = asDay(item.e);
    if (item.ud !== undefined) item.ud = asDay(item.ud);
    return item;
  }

  /** What goes over the wire for an item: no local markers, no id (that travels separately). */
  function wireItem(object) {
    var out = {};
    Object.keys(object || {}).forEach(function (k) {
      if (k.charAt(0) === '_' || k === 'id') return;
      out[k] = object[k];
    });
    return out;
  }

  function GasError(status, code, message) {
    var err = new Error(message);
    err.status = status; err.code = code;
    return err;
  }

  /* A failure worth trying again: the sheet could not be reached, or it timed out. Anything
     else is the sheet answering "no", and trying again would get the same answer. */
  function isTransient(e) { return !e || e.status === 0 || e.code === 'offline' || e.status >= 500; }

  class GasStore {
    constructor(url) {
      this.url = String(url || global.GAS_URL || '').trim();
      this.kind = 'api';              // the Presenter treats both backends identically
      this.flavour = 'gsheet';
      /* Chat works here, a few seconds behind: Apps Script cannot hold a socket open, so the
         client falls back to polling, which it already knows how to do. */
      this.supportsChat = true;
      this.subs = {};
      this.cache = { items: [], taskhist: [], users: [], requests: [], team: [] };
      this.ready = {};                // which collections hold real data yet
      this.usersById = {};
      this.token = readToken();
      this.session = null;
      this.pollMs = 12000;            // Apps Script is slower than a local server, so poll gently
      /* A chat round here already takes several seconds, so the pause after one is short:
         the request is the wait. */
      this.chatPollMs = 2500;
      this.timer = null;
      this.onAuthLost = function () {};
      this.onNotice = function () {};
      this.onError = function () {};

      /* The items as the sheet last gave them, and the changes made here since that it has not
         confirmed yet. What the page shows is the one with the other laid over it. */
      this.base = [];
      this.cacheKey = CACHE_PREFIX + this.url;
      this.outboxKey = OUTBOX_PREFIX + this.url;
      var saved = storageGet(this.outboxKey);
      this.outbox = (saved && Array.isArray(saved.ops)) ? saved.ops : [];
      this.outboxOwner = (saved && saved.owner) || '';
      this.inflight = {};
      this.writeGen = 0;              // bumped by every confirmed write
      this.flushing = null;
      this.retryMs = 0;
      this.retryTimer = null;
      this.persistTimer = null;
    }

    /* ---------- one call to the script ---------- */
    async call(action, payload, timeoutMs) {
      if (!this.url) throw GasError(0, 'offline', 'No Google Apps Script URL configured');
      var body = Object.assign({ action: action }, payload || {});
      if (this.token) body.token = this.token;

      /* Give up rather than leave the page on "Connecting…" if the script never answers. */
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = (controller && timeoutMs) ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;

      var res;
      try {
        res = await fetch(this.url, {
          method: 'POST',
          /* text/plain keeps this a simple request, so the browser sends no preflight. */
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          redirect: 'follow',
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        });
      } catch (e) {
        throw GasError(0, 'offline', (e && e.name === 'AbortError')
          ? 'The Google Sheet backend did not answer in time'
          : 'Cannot reach the Google Sheet backend – check your connection');
      } finally {
        if (timer) clearTimeout(timer);
      }

      var text = await res.text();
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

      if (!data) {
        /* Apps Script returns an HTML page when the deployment is private or the URL is wrong. */
        throw GasError(res.status || 500, 'bad_response',
          'The script did not answer with data. Check that the Web App is deployed with access "Anyone".');
      }
      if (data.error) {
        var status = data.error.status || (data.error.code === 'unauthorized' ? 401 : 400);
        /* Only a genuine "you are not signed in" ends the session. A refused password or a
           forbidden action must not throw the person out of the page. */
        if (status === 401 && data.error.code === 'unauthorized' && this.session) {
          this.signedOut(); this.onAuthLost();
        }
        throw GasError(status, data.error.code || 'error', data.error.message || 'Request failed');
      }
      return data;
    }

    /** Parity with js/api.js so shared code can use either store. Paths this backend does not
        implement must fail loudly: answering something unrelated would look like success. */
    request(method, path, body) {
      /* The chat paths carry a colleague's address in them, so they are matched rather than
         looked up. Everything else is a fixed path. */
      if (path.indexOf('/api/chat/') === 0) {
        var rest = path.slice('/api/chat/'.length);
        var who = function (prefix) { return decodeURIComponent(rest.slice(prefix.length)); };
        if (rest === 'contacts') return this.call('chatContacts');
        if (rest === 'unread') return this.call('chatUnread');
        if (rest.indexOf('with/') === 0) {
          return method === 'POST'
            ? this.call('chatSend', { email: who('with/'), body: body && body.body })
            : this.call('chatWith', { email: who('with/') });
        }
        if (rest.indexOf('read/') === 0) return this.call('chatRead', { email: who('read/') });
      }

      var map = {
        '/api/items': 'listItems', '/api/export': 'exportData',
        '/api/stats': 'stats', '/api/users': 'listUsers', '/api/audit': 'audit',
        '/api/health': 'health',
      };
      if (method === 'POST' && path === '/api/items') return this.call('saveItem', { item: body });
      var action = map[path];
      if (!action) {
        return Promise.reject(GasError(404, 'not_supported',
          'The Google Sheets backend does not offer ' + path));
      }
      return this.call(action, body);
    }

    get role() { return (this.session && this.session.user && this.session.user.role) || ''; }
    get email() { return (this.session && this.session.user && this.session.user.email) || ''; }

    /* Signing out takes this browser's copy of the data with it, so the next person to use the
       device does not see it. Changes not yet sent are kept, but only for the same person: they
       go out when that person signs in again, and are discarded if somebody else does. */
    signedOut() {
      this.session = null; this.token = ''; writeToken(''); this.stopPolling();
      clearTimeout(this.persistTimer);
      storageDel(this.cacheKey);
    }

    /* ---------- authentication ---------- */
    /* Apps Script is slow. A warm health call measures 3.1–5.5s here, and the first one after
       an idle spell has to compile and run the whole script before answering. The old six-second
       deadline was inside that range, so one ordinary slow reply sent the page off to this
       browser's own storage – which looks exactly like saved work vanishing. Wait properly, and
       give a cold script a second chance. */
    async probe() {
      var budgets = [15000, 30000];
      for (var i = 0; i < budgets.length; i++) {
        try { this.lastError = null; return await this.call('health', null, budgets[i]); }
        catch (e) {
          this.lastError = e;
          /* Slowness earns another try; a wrong URL or a private deployment does not. */
          if (e.code !== 'offline' || i === budgets.length - 1) return null;
        }
      }
      return null;
    }

    /**
     * Start from the copy kept in this browser, if there is one for this person.
     *
     * Returns the saved session when the page can draw straight away - a token is held and the
     * copy is recent - or null when it has to start from nothing. The session is not trusted
     * because it was saved: the Presenter asks the sheet who this is in the background, and a
     * token the sheet no longer accepts ends the session the usual way.
     */
    warmStart() {
      if (!this.token) return null;
      var saved = storageGet(this.cacheKey);
      if (!saved || saved.v !== CACHE_VERSION || !saved.session || !saved.session.user) return null;
      if (!saved.at || Date.now() - saved.at > CACHE_MAX_AGE_MS) return null;

      this.session = saved.session;
      this.emailReset = !!saved.emailReset;
      this.base = (saved.base || []).map(itemIn);
      this.cache.taskhist = saved.taskhist || [];
      this.cache.team = saved.team || [];
      this.cache.users = saved.users || [];
      this.cache.requests = saved.requests || [];
      this.indexUsers();
      this.rev = '';                  // the first read after a start is always a full one
      ['items', 'taskhist', 'team'].forEach(function (k) { this.ready[k] = true; }, this);
      if (this.role === 'superadmin') { this.ready.users = true; this.ready.requests = true; }
      this.adoptOutbox();
      this.compose();
      return saved.session;
    }

    /** Keep what is in this browser, for the next visit. Gathered into one write a moment later. */
    persistSoon() {
      var self = this;
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(function () { self.persist(); }, 400);
    }

    persist() {
      if (!this.session || !this.token) return;
      var snapshot = {
        v: CACHE_VERSION, at: Date.now(), session: this.session, emailReset: !!this.emailReset,
        base: this.base, taskhist: this.cache.taskhist, team: this.cache.team,
        users: this.cache.users, requests: this.cache.requests,
      };
      /* A browser that is out of room gets a slimmer copy rather than none: the items are what
         make the first screen, the rest can wait for the sheet. */
      if (!storageSet(this.cacheKey, snapshot)) {
        snapshot.taskhist = []; snapshot.users = []; snapshot.requests = [];
        if (!storageSet(this.cacheKey, snapshot)) storageDel(this.cacheKey);
      }
    }

    async me() {
      if (!this.token) return { user: null, setupRequired: false };
      var payload = await this.call('me');
      this.session = payload && payload.user ? payload : null;
      if (!this.session) this.signedOut(); else { this.adoptOutbox(); this.persistSoon(); }
      return payload;
    }

    async login(email, password) {
      var payload = await this.call('login', { email: email, password: password });
      this.token = payload.token; writeToken(this.token);
      this.session = payload;
      this.adoptOutbox();
      return payload;
    }

    async setup(name, email, password) {
      var payload = await this.call('setup', { name: name, email: email, password: password });
      this.token = payload.token; writeToken(this.token);
      this.session = payload;
      this.adoptOutbox();
      return payload;
    }

    async logout() {
      try { await this.call('logout'); } catch (e) { /* the session may already be gone */ }
      this.signedOut();
    }

    /* ---------- forgotten password ---------- */
    /** Ask the script to email a six-digit code. The answer is the same whether or not the
        address has an account, so nobody can use this to discover who is registered. */
    forgotPassword(email) { return this.call('forgotPassword', { email: email }, 30000); }

    /** Finish the reset with the emailed code and the new password. */
    resetPassword(email, code, newPassword) {
      return this.call('resetPassword', { email: email, code: code, newPassword: newPassword }, 30000);
    }

    /* ---------- your own account ---------- */
    /** Change your own password; the script hands back a fresh session token. */
    async changePassword(currentPassword, newPassword) {
      const res = await this.call('changePassword',
        { currentPassword: currentPassword, newPassword: newPassword }, 30000);
      if (res && res.token) { this.token = res.token; writeToken(this.token); }
      return res;
    }

    /** Change the name colleagues see beside your sign-in. */
    async updateProfile(name) {
      const res = await this.call('updateProfile', { name: name });
      if (this.session && this.session.user) this.session.user.name = name;
      this.persistSoon();
      return res;
    }

    /* ---------- the store interface model.js expects ---------- */
    watch(collection, cb, err) {
      (this.subs[collection] = this.subs[collection] || []).push(cb);
      /* Only hand over what is real. An empty list before the first load would draw an empty
         dashboard; the page shows its loading placeholders until there is something to show. */
      if (this.ready[collection]) cb(this.cache[collection] || []);
      if (err) this.onError = err;
      this.startPolling();
      this.refresh(collection);
      var self = this;
      return function () {
        self.subs[collection] = (self.subs[collection] || []).filter(function (f) { return f !== cb; });
      };
    }

    emit(collection) {
      this.ready[collection] = true;
      var rows = this.cache[collection] || [];
      (this.subs[collection] || []).forEach(function (cb) {
        try { cb(rows); } catch (e) {}
      });
      this.persistSoon();
    }

    /* ---------- items: shown at once, sent behind ---------- */

    /** Rebuild what the page shows: the sheet's last answer with the unsent changes laid over. */
    compose() {
      var list = this.base.slice();
      var self = this;
      var at = function (target) {
        for (var i = 0; i < list.length; i++) {
          if (target.tmp ? list[i]._tmp === target.tmp : (list[i].id === target.id && !list[i]._tmp)) return i;
        }
        return -1;
      };
      this.outbox.forEach(function (op) {
        if (op.op === 'create') {
          /* Already in the sheet's answer - written, the reply still on its way: don't show twice. */
          if (op.sentAt && self.base.some(function (item) { return self.matchesCreate(op, item); })) return;
          list.push(Object.assign({ s: 'Ongoing' }, op.item, {
            id: op.shownId, _tmp: op.tmp, _pending: true,
            createdBy: op.by, createdAt: new Date(op.at).toISOString()
          }));
        } else if (op.op === 'save') {
          var i = at(op.target);
          if (i !== -1) list[i] = Object.assign({}, list[i], op.item, { _pending: true });
        } else if (op.op === 'delete') {
          var j = at(op.target);
          if (j !== -1) list.splice(j, 1);
        }
      });
      this.cache.items = list;
    }

    /** Show the latest state and keep it for the next visit. */
    commit() {
      this.compose();
      this.emit('items');
    }

    saveOutbox() {
      if (this.outbox.length) storageSet(this.outboxKey, { owner: this.outboxOwner || this.email, ops: this.outbox });
      else storageDel(this.outboxKey);
    }

    /** Changes left over from an earlier visit belong to whoever made them, and nobody else. */
    adoptOutbox() {
      if (!this.outbox.length || !this.email) return;
      if (this.outboxOwner && this.outboxOwner !== this.email) {
        this.outbox = []; this.outboxOwner = ''; this.saveOutbox();
        return;
      }
      this.outboxOwner = this.email;
    }

    /** The item a change is about: an unconfirmed new one by its temporary key, else by its id. */
    targetFor(id) {
      var items = this.cache.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === id) return items[i]._tmp ? { tmp: items[i]._tmp } : { id: id };
      }
      return { id: id };
    }

    /** Has the sheet already written this create? Same kind, title and lead, by the same person, just now. */
    matchesCreate(op, item) {
      if (!op.sentAt || item._tmp) return false;
      if (item.type !== op.item.type || item.title !== op.item.title) return false;
      if (String(item.f1 || '') !== String(op.item.f1 || '')) return false;
      if (item.createdBy && op.by && item.createdBy !== op.by) return false;
      var made = Date.parse(item.createdAt || '');
      return isNaN(made) || made >= op.sentAt - 120000;
    }

    enqueue(op) {
      op.at = op.at || Date.now();
      op.by = this.email;
      this.outboxOwner = this.email;
      this.outbox.push(op);
      this.saveOutbox();
      this.commit();
      this.flush();
    }

    /** Send the queued changes, one at a time, in the order they were made. */
    flush() {
      if (this.flushing) return this.flushing;
      if (!this.outbox.length || !this.token) return Promise.resolve();
      var self = this;
      this.flushing = (async function () {
        while (self.outbox.length && self.token) {
          var op = self.outbox[0];
          try {
            await self.send(op);
            self.outbox.shift();
            self.retryMs = 0;
            self.saveOutbox();
            self.commit();
          } catch (e) {
            if (e && e.code === 'unauthorized') break;           // kept; sent after signing in
            if (isTransient(e)) { self.retryLater(); break; }  // kept; sent when the sheet answers
            /* The sheet said no. Trying again would get the same answer, so the change is
               taken back, along with anything queued behind it for the same new item. */
            self.outbox.shift();
            if (op.op === 'create') {
              self.outbox = self.outbox.filter(function (o) { return !(o.target && o.target.tmp === op.tmp); });
            }
            self.saveOutbox();
            self.commit();
            self.onNotice('Could not save "' + (op.title || 'item') + '": ' + (e.message || e.code) + ' – the change was undone');
          }
        }
      })();
      var done = function () { self.flushing = null; };
      this.flushing.then(done, done);
      return this.flushing;
    }

    retryLater() {
      var self = this;
      this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : 5000, 60000);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(function () { self.flush(); }, this.retryMs);
    }

    async send(op) {
      if (op.op === 'create') {
        /* Sent before and never confirmed - the tab closed, or the reply was lost. Look before
           sending again, so one change does not become two rows. */
        if (op.sentAt) {
          var now = await this.call('listItems', {});
          var self = this;
          var found = ((now && now.items) || []).map(itemIn).filter(function (item) { return self.matchesCreate(op, item); })[0];
          if (found) { this.confirmCreate(op, found, now); return; }
        }
        op.sentAt = Date.now();
        this.saveOutbox();
        var created = itemIn(await this.call('saveItem', { item: op.item, clientKey: op.tmp }));
        this.confirmCreate(op, created, null);
        return;
      }
      if (op.target && op.target.tmp) return;          // its create was refused; nothing to change
      if (op.op === 'save') {
        var saved = itemIn(await this.call('saveItem', { id: op.target.id, item: op.item }));
        this.place(saved);
        return;
      }
      if (op.op === 'delete') {
        /* Gone already - an earlier attempt that did reach the sheet. That is what was asked. */
        try { await this.call('deleteItem', { id: op.target.id }); }
        catch (e) { if (e.code !== 'not_found') throw e; }
        this.base = this.base.filter(function (item) { return item.id !== op.target.id; });
        this.wrote();
      }
    }

    confirmCreate(op, created, fullList) {
      if (fullList && fullList.items) this.base = fullList.items.map(itemIn);
      this.place(created);
      /* Anything queued for this item under its temporary key now goes to its real id. */
      this.outbox.forEach(function (o) {
        if (o.target && o.target.tmp === op.tmp) o.target = { id: created.id };
      });
    }

    /** Put a confirmed item into the sheet's copy, in place or at the end. */
    place(saved) {
      if (!saved || !saved.id) return;
      var at = -1;
      for (var i = 0; i < this.base.length; i++) if (this.base[i].id === saved.id) { at = i; break; }
      if (at === -1) this.base.push(saved); else this.base[at] = saved;
      this.wrote();
    }

    /** A write was confirmed: any read already on its way predates it and must not win. */
    wrote() { this.writeGen += 1; this.rev = ''; }

    async set(collection, id, object, options) {
      if (collection === 'items') {
        if (options && options.fresh) {
          /* New: shown at once under the id the page worked out, sent without one - the sheet
             gives out the real id, and the page's guess could belong to a row somebody else
             added since. */
          this.enqueue({
            op: 'create', tmp: 'tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            shownId: id, item: wireItem(object), title: object.title
          });
          return;
        }
        this.change(id, wireItem(object), object.title);
        return;
      } else if (collection === 'users') {
        await this.saveUser(id, object);
      } else if (collection === 'requests') {
        await this.call('createRequest', object);
      } else if (collection === 'team') {
        await this.call('saveTeam', object);
      } else if (collection === 'taskhist') {
        await this.call('saveArchive', { id: id, rows: (object && object.rows) || [] });
      }
      await this.refresh(collection);
    }

    /** An edit to an item: folded into its create if that has not gone yet, else queued. */
    change(id, patch, title) {
      var target = this.targetFor(id);
      if (target.tmp) {
        for (var i = 0; i < this.outbox.length; i++) {
          var op = this.outbox[i];
          if (op.op === 'create' && op.tmp === target.tmp && !op.sentAt) {
            Object.assign(op.item, patch);
            this.saveOutbox();
            this.commit();
            return;
          }
        }
      }
      var current = (this.cache.items || []).filter(function (item) { return item.id === id; })[0];
      this.enqueue({ op: 'save', target: target, item: patch, title: title || (current && current.title) });
    }

    async update(collection, id, patch) {
      if (collection === 'items') { this.change(id, wireItem(patch)); return; }
      if (collection === 'users') {
        var body = { email: this.emailFor(id) };
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.role !== undefined) body.role = patch.role;
        if (patch.password !== undefined) body.password = patch.password;
        if (patch.pw !== undefined) body.password = patch.pw;
        if (patch.id !== undefined) body.externalId = patch.id;
        await this.call('updateUser', body);
      }
      await this.refresh(collection);
    }

    async remove(collection, id) {
      if (collection === 'items') {
        var target = this.targetFor(id);
        var current = (this.cache.items || []).filter(function (item) { return item.id === id; })[0];
        /* A new item that has not gone yet is simply never sent. */
        if (target.tmp) {
          var unsent = this.outbox.some(function (op) { return op.op === 'create' && op.tmp === target.tmp && !op.sentAt; });
          if (unsent) {
            this.outbox = this.outbox.filter(function (op) {
              return op.tmp !== target.tmp && !(op.target && op.target.tmp === target.tmp);
            });
            this.saveOutbox();
            this.commit();
            return;
          }
        }
        this.enqueue({ op: 'delete', target: target, title: current && current.title });
        return;
      }
      if (collection === 'users') await this.call('deleteUser', { email: this.emailFor(id) });
      else if (collection === 'requests') await this.call('deleteRequest', { id: id });
      else if (collection === 'team') await this.call('deleteTeam', { id: id });
      await this.refresh(collection);
    }

    /** Rename a person on every item at once, server side, then reread the items. */
    async renamePerson(from, to) {
      await this.flush();             // earlier edits first, so the rename sees them
      var result = await this.call('renamePerson', { from: from, to: to });
      this.wrote();
      await this.refresh('items');
      return (result && result.count) || 0;
    }

    emailFor(docId) {
      return this.usersById[docId] || String(docId).replace(/_/g, '.');
    }

    indexUsers() {
      this.usersById = {};
      for (var i = 0; i < (this.cache.users || []).length; i++) {
        this.usersById[this.cache.users[i].id] = this.cache.users[i].email;
      }
    }

    async saveUser(docId, object) {
      var email = String(object.email || this.emailFor(docId)).toLowerCase();
      var known = (this.cache.users || []).some(function (u) { return u.email === email; });
      var password = object.password || object.pw || '';

      if (known) {
        await this.call('updateUser', {
          email: email, name: object.name, role: object.role,
          password: password || undefined, externalId: object.id || undefined,
        });
        return;
      }
      var pass = password, generated = false;
      if (!pass) { pass = 'temp-' + Math.random().toString(36).slice(2, 8); generated = true; }
      await this.call('createUser', {
        email: email, name: object.name, role: object.role, password: pass,
        externalId: object.id || undefined, requestId: object.requestId || undefined,
      });
      if (generated) {
        this.onNotice(object.name + ' added. Temporary password: ' + pass + ' – reset it with the key button.');
      }
    }

    /* ---------- refreshing ---------- */
    /* One read per collection at a time: the page asks for the same list from several places
       as it starts, and every extra request costs Apps Script seconds. */
    refresh(collection) {
      var key = collection === 'requests' ? 'users' : collection;
      if (this.inflight[key]) return this.inflight[key];
      var self = this;
      var running = this.refreshNow(collection);
      this.inflight[key] = running;
      var done = function () { delete self.inflight[key]; };
      running.then(done, done);
      return running;
    }

    async refreshNow(collection) {
      try {
        if (collection === 'items') {
          /* The sheet keeps a counter that every write bumps. Sending the last one seen lets the
             script answer "nothing changed" in a moment instead of reading three tabs. */
          var gen = this.writeGen;
          var data = await this.call('listItems', { rev: this.rev || '' });
          if (data && data.unchanged) return;
          /* A write was confirmed while this read was on its way, so this answer is older than
             what is already here. It is dropped; the next read will be a full one. */
          if (gen !== this.writeGen) return;
          this.rev = (data && data.rev) || '';
          this.base = (((data && data.items) || [])).map(itemIn);
          this.commit();
        } else if (collection === 'taskhist') {
          var arch = await this.call('listArchive');
          this.cache.taskhist = (arch && arch.batches) || [];
          this.emit('taskhist');
        } else if (collection === 'team') {
          var roster = await this.call('listTeam');
          this.cache.team = (roster && roster.members) || [];
          this.emit('team');
        } else if (collection === 'users' || collection === 'requests') {
          if (this.role !== 'superadmin') {
            this.cache.users = []; this.cache.requests = [];
            this.emit('users'); this.emit('requests');
            return;
          }
          var payload = await this.call('listUsers');
          this.cache.users = (payload && payload.users) || [];
          this.cache.requests = (payload && payload.requests) || [];
          this.indexUsers();
          this.emit('users'); this.emit('requests');
        }
      } catch (e) {
        if (e.status === 403) { this.cache[collection] = []; this.emit(collection); return; }
        this.onError(e);
      }
    }

    /* Apps Script answers each request in a few seconds whatever it is asked, so three in a row
       cost three times as long as three at once. They go out together. */
    async refreshAll() {
      var loads = [this.refresh('items'), this.refresh('taskhist'), this.refresh('team')];
      if (this.role === 'superadmin') loads.push(this.refresh('users'));
      if (this.outbox.length) loads.push(this.flush());
      await Promise.all(loads);
    }

    startPolling() {
      if (this.timer) return;
      var self = this;
      this.timer = setInterval(function () {
        if (document.hidden || !self.session) return;
        self.refreshAll();
      }, this.pollMs);
      if (!this.listening) {
        this.listening = true;
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden && self.session) self.refreshAll();
        });
        /* Back on the network: send what is waiting straight away rather than at the next try. */
        global.addEventListener('online', function () { if (self.session) self.flush(); });
      }
    }

    stopPolling() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  }

  global.GasStore = GasStore;
})(window);
