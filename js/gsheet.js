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

   Part of the MVP split: js/model.js · js/view.js · js/export.js · js/gsheet.js · js/presenter.js */

(function (global) {
  'use strict';

  var TOKEN_KEY = 'tracker.gas.token';

  function readToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function writeToken(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} }

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
    return item;
  }

  function GasError(status, code, message) {
    var err = new Error(message);
    err.status = status; err.code = code;
    return err;
  }

  class GasStore {
    constructor(url) {
      this.url = String(url || global.GAS_URL || '').trim();
      this.kind = 'api';              // the Presenter treats both backends identically
      this.flavour = 'gsheet';
      /* Chat works here, a few seconds behind: Apps Script cannot hold a socket open, so the
         client falls back to polling, which it already knows how to do. */
      this.supportsChat = true;
      this.subs = {};
      this.cache = { items: [], taskhist: [], users: [], requests: [] };
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

    signedOut() { this.session = null; this.token = ''; writeToken(''); this.stopPolling(); }

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

    async me() {
      if (!this.token) return { user: null, setupRequired: false };
      var payload = await this.call('me');
      this.session = payload && payload.user ? payload : null;
      if (!this.session) this.signedOut();
      return payload;
    }

    async login(email, password) {
      var payload = await this.call('login', { email: email, password: password });
      this.token = payload.token; writeToken(this.token);
      this.session = payload;
      return payload;
    }

    async setup(name, email, password) {
      var payload = await this.call('setup', { name: name, email: email, password: password });
      this.token = payload.token; writeToken(this.token);
      this.session = payload;
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
      return res;
    }

    /* ---------- the store interface model.js expects ---------- */
    watch(collection, cb, err) {
      (this.subs[collection] = this.subs[collection] || []).push(cb);
      cb(this.cache[collection] || []);
      if (err) this.onError = err;
      this.startPolling();
      this.refresh(collection);
      var self = this;
      return function () {
        self.subs[collection] = (self.subs[collection] || []).filter(function (f) { return f !== cb; });
      };
    }

    emit(collection) {
      var rows = this.cache[collection] || [];
      (this.subs[collection] || []).forEach(function (cb) {
        try { cb(rows); } catch (e) {}
      });
    }

    async set(collection, id, object, options) {
      if (collection === 'items') {
        if (options && options.fresh) {
          /* The page guessed an id from what it had loaded, but somebody else may have taken it
             since. Sending it would make the server update that row. New items go without one,
             and the sheet hands back the id it actually gave. */
          var fresh = Object.assign({}, object); delete fresh.id;
          await this.call('saveItem', { item: fresh });
        } else {
          await this.call('saveItem', { id: id, item: object });
        }
      } else if (collection === 'users') {
        await this.saveUser(id, object);
      } else if (collection === 'requests') {
        await this.call('createRequest', object);
      } else if (collection === 'taskhist') {
        await this.call('saveArchive', { id: id, rows: (object && object.rows) || [] });
      }
      await this.refresh(collection);
    }

    async update(collection, id, patch) {
      if (collection === 'items') {
        await this.call('saveItem', { id: id, item: patch });
      } else if (collection === 'users') {
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
      if (collection === 'items') await this.call('deleteItem', { id: id });
      else if (collection === 'users') await this.call('deleteUser', { email: this.emailFor(id) });
      else if (collection === 'requests') await this.call('deleteRequest', { id: id });
      await this.refresh(collection);
    }

    emailFor(docId) {
      return this.usersById[docId] || String(docId).replace(/_/g, '.');
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
    async refresh(collection) {
      try {
        if (collection === 'items') {
          var data = await this.call('listItems');
          this.cache.items = (((data && data.items) || [])).map(itemIn);
          this.emit('items');
        } else if (collection === 'taskhist') {
          var arch = await this.call('listArchive');
          this.cache.taskhist = (arch && arch.batches) || [];
          this.emit('taskhist');
        } else if (collection === 'users' || collection === 'requests') {
          if (this.role !== 'superadmin') {
            this.cache.users = []; this.cache.requests = [];
            this.emit('users'); this.emit('requests');
            return;
          }
          var payload = await this.call('listUsers');
          this.cache.users = (payload && payload.users) || [];
          this.cache.requests = (payload && payload.requests) || [];
          this.usersById = {};
          for (var i = 0; i < this.cache.users.length; i++) {
            this.usersById[this.cache.users[i].id] = this.cache.users[i].email;
          }
          this.emit('users'); this.emit('requests');
        }
      } catch (e) {
        if (e.status === 403) { this.cache[collection] = []; this.emit(collection); return; }
        this.onError(e);
      }
    }

    async refreshAll() {
      await this.refresh('items');
      await this.refresh('taskhist');
      if (this.role === 'superadmin') await this.refresh('users');
    }

    startPolling() {
      if (this.timer) return;
      var self = this;
      this.timer = setInterval(function () {
        if (document.hidden || !self.session) return;
        self.refreshAll();
      }, this.pollMs);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && self.session) self.refreshAll();
      });
    }

    stopPolling() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  }

  global.GasStore = GasStore;
})(window);
