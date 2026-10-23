/* api.js – talks to the Node.js backend (server/) and presents it to the rest of the app with
   exactly the same shape as LocalStore and CloudStore: watch / set / update / remove.

   Because the interface matches, model.js, view.js and export.js need no changes at all:
   the Presenter simply picks this store when a backend answers at /api/health.

   What it adds on top of a plain store:
     · sign-in, sign-out and "who am I" against the server
     · the role the SERVER says you have (the browser never decides its own rights)
     · a CSRF token taken from the readable cookie and sent on every change
     · polling, so one person's change shows up for everyone else within a few seconds

   Part of the MVP split: js/model.js · js/view.js · js/export.js · js/api.js · js/presenter.js */

(function (global) {
  'use strict';

  /* Where the API lives. Same origin by default; set window.API_BASE before this script to
     point a statically hosted page (GitHub Pages, Vercel) at a server somewhere else. */
  const BASE = String(global.API_BASE || '').replace(/\/+$/, '');
  const url = path => BASE + path;

  const readCookie = name => {
    try {
      const hit = document.cookie.split(';').map(s => s.trim())
        .find(c => c.indexOf(name + '=') === 0);
      return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
    } catch (e) { return ''; }
  };

  class ApiError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
  }

  class ApiStore {
    constructor() {
      this.kind = 'api';
      this.flavour = 'node';
      this.supportsChat = true;       // the Node server carries the Socket.IO side of chat
      this.subs = {};                 // collection -> [callback]
      this.cache = { items: [], taskhist: [], users: [], requests: [], team: [] };
      this.usersById = {};            // the browser's underscore id -> email
      this.pollMs = 8000;
      this.timer = null;
      this.session = null;            // {user, permissions, csrf}
      this.onAuthLost = () => {};     // the Presenter shows the sign-in screen again
      this.onNotice = () => {};       // a message worth showing the person
      this.onError = () => {};
    }

    /* ---------- low-level request ---------- */
    async request(method, path, body) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const csrf = (this.session && this.session.csrf) || readCookie('tracker_csrf');
      if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

      let res;
      try {
        res = await fetch(url(path), {
          method,
          headers,
          credentials: 'include',
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        throw new ApiError(0, 'offline', 'Cannot reach the server – check your connection');
      }

      let payload = null;
      const text = await res.text();
      if (text) { try { payload = JSON.parse(text); } catch (e) { payload = null; } }

      if (!res.ok) {
        const err = (payload && payload.error) || {};
        /* Only a genuine "you are not signed in" ends the session. A refused password or a
           forbidden action must not throw the person out of the page. */
        if (res.status === 401 && (err.code === 'unauthorized' || !err.code) && this.session) {
          this.session = null; this.onAuthLost();
        }
        throw new ApiError(res.status, err.code || 'error', err.message || `Request failed (${res.status})`);
      }
      return payload;
    }

    get role() { return (this.session && this.session.user && this.session.user.role) || ''; }

    /* ---------- authentication ---------- */
    static async probe() {
      try {
        const res = await fetch(url('/api/health'), { credentials: 'include' });
        if (!res.ok) return null;
        const body = await res.json();
        return body && body.ok ? body : null;
      } catch (e) { return null; }
    }

    async me() {
      const payload = await this.request('GET', '/api/auth/me');
      this.session = payload && payload.user ? payload : null;
      return payload;
    }

    async login(email, password) {
      this.session = await this.request('POST', '/api/auth/login', { email, password });
      return this.session;
    }

    async setup(name, email, password) {
      this.session = await this.request('POST', '/api/auth/setup', { name, email, password });
      return this.session;
    }

    async logout() {
      try { await this.request('POST', '/api/auth/logout'); } catch (e) { /* already gone */ }
      this.session = null;
      this.stopPolling();
    }

    /* ---------- forgotten password ---------- */
    /** Ask the server to email a six-digit code. The answer is deliberately the same whether
        or not the address has an account. */
    forgotPassword(email) { return this.request('POST', '/api/auth/forgot', { email }); }

    /** Finish the reset with the emailed code and the new password. */
    resetPassword(email, code, newPassword) {
      return this.request('POST', '/api/auth/reset', { email, code, newPassword });
    }

    /* ---------- your own account ---------- */
    /** Change your own password; the server issues a fresh session. */
    async changePassword(currentPassword, newPassword) {
      const res = await this.request('POST', '/api/auth/password', { currentPassword, newPassword });
      if (res && res.csrf && this.session) this.session.csrf = res.csrf;
      return res;
    }

    /** Change the name colleagues see beside your sign-in. */
    async updateProfile(name) {
      const res = await this.request('POST', '/api/auth/profile', { name });
      if (this.session && this.session.user) this.session.user.name = name;
      return res;
    }

    /* ---------- the store interface used by model.js ---------- */
    watch(collection, cb, err) {
      (this.subs[collection] = this.subs[collection] || []).push(cb);
      cb(this.cache[collection] || []);
      if (err) this.onError = err;
      this.startPolling();
      this.refresh(collection);
      return () => {
        this.subs[collection] = (this.subs[collection] || []).filter(f => f !== cb);
      };
    }

    emit(collection) {
      const rows = this.cache[collection] || [];
      for (const cb of this.subs[collection] || []) {
        try { cb(rows); } catch (e) { /* a broken listener must not stop the others */ }
      }
    }

    async set(collection, id, object, options) {
      if (collection === 'items') {
        if (options && options.fresh) {
          const fresh = { ...object }; delete fresh.id;      // the server gives out ids
          await this.request('POST', '/api/items', fresh);
        } else {
          await this.request('PUT', `/api/items/${encodeURIComponent(id)}`, object);
        }
      } else if (collection === 'users') {
        await this.saveUser(id, object);
      } else if (collection === 'requests') {
        await this.request('POST', '/api/requests', object);
      } else if (collection === 'team') {
        await this.request('POST', '/api/team', object);
      } else if (collection === 'taskhist') {
        await this.request('PUT', `/api/items/archive/${encodeURIComponent(id)}`, { rows: object.rows || [] });
      }
      await this.refresh(collection);
    }

    async update(collection, id, patch) {
      if (collection === 'items') {
        await this.request('PATCH', `/api/items/${encodeURIComponent(id)}`, patch);
      } else if (collection === 'users') {
        const email = this.emailFor(id);
        const body = {};
        if (patch.name !== undefined) body.name = patch.name;
        if (patch.role !== undefined) body.role = patch.role;
        if (patch.password !== undefined) body.password = patch.password;
        if (patch.pw !== undefined) body.password = patch.pw;
        if (patch.id !== undefined) body.externalId = patch.id;
        await this.request('PATCH', `/api/users/${encodeURIComponent(email)}`, body);
      }
      await this.refresh(collection);
    }

    /** Rename a person on every item at once, server side, then reread the items. */
    async renamePerson(from, to) {
      const result = await this.request('POST', '/api/team/rename', { from, to });
      await this.refresh('items');
      return (result && result.count) || 0;
    }

    async remove(collection, id) {
      if (collection === 'items') {
        await this.request('DELETE', `/api/items/${encodeURIComponent(id)}`);
      } else if (collection === 'users') {
        await this.request('DELETE', `/api/users/${encodeURIComponent(this.emailFor(id))}`);
      } else if (collection === 'requests') {
        await this.request('DELETE', `/api/requests/${encodeURIComponent(id)}`);
      } else if (collection === 'team') {
        await this.request('DELETE', `/api/team/${encodeURIComponent(id)}`);
      }
      await this.refresh(collection);
    }

    /* ---------- users need a little translation ---------- */
    emailFor(docId) {
      return this.usersById[docId] || String(docId).replace(/_/g, '.');
    }

    /** The Users dialog sends a whole record; decide between creating and patching. */
    async saveUser(docId, object) {
      const email = String(object.email || this.emailFor(docId)).toLowerCase();
      const known = (this.cache.users || []).some(u => u.email === email);
      /* The browser may have pre-hashed the password (local mode habit); either is accepted,
         and whatever arrives is hashed again with scrypt on the server. */
      const password = object.password || object.pw || '';

      if (known) {
        await this.request('PATCH', `/api/users/${encodeURIComponent(email)}`, {
          name: object.name, role: object.role,
          ...(password ? { password } : {}),
          ...(object.id ? { externalId: object.id } : {}),
        });
        return;
      }
      let pass = password;
      let generated = false;
      if (!pass) { pass = 'temp-' + Math.random().toString(36).slice(2, 8); generated = true; }
      await this.request('POST', '/api/users', {
        email, name: object.name, role: object.role, password: pass,
        externalId: object.id || undefined,
        requestId: object.requestId || undefined,
      });
      if (generated) {
        this.onNotice(`${object.name} added. Temporary password: ${pass} – reset it with the key button.`);
      }
    }

    /* ---------- refreshing ---------- */
    async refresh(collection) {
      try {
        if (collection === 'items') {
          const data = await this.request('GET', '/api/items');
          this.cache.items = (data && data.items) || [];
          this.emit('items');
        } else if (collection === 'taskhist') {
          const data = await this.request('GET', '/api/items/archive');
          this.cache.taskhist = (data && data.batches) || [];
          this.emit('taskhist');
        } else if (collection === 'team') {
          const roster = await this.request('GET', '/api/team');
          this.cache.team = (roster && roster.members) || [];
          this.emit('team');
        } else if (collection === 'users' || collection === 'requests') {
          /* One call returns both; only a super admin may make it. */
          if (this.role !== 'superadmin') {
            this.cache.users = []; this.cache.requests = [];
            this.emit('users'); this.emit('requests');
            return;
          }
          const data = await this.request('GET', '/api/users');
          this.cache.users = (data && data.users) || [];
          this.cache.requests = (data && data.requests) || [];
          this.usersById = {};
          for (const u of this.cache.users) this.usersById[u.id] = u.email;
          this.emit('users'); this.emit('requests');
        }
      } catch (e) {
        if (e.status === 403) {           // a role that may not read this collection
          this.cache[collection] = [];
          this.emit(collection);
          return;
        }
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
      this.timer = setInterval(() => {
        if (document.hidden || !this.session) return;   // no traffic while the tab is in the background
        this.refreshAll();
      }, this.pollMs);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.session) this.refreshAll();
      });
    }

    stopPolling() {
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
  }

  global.ApiStore = ApiStore;
  global.ApiError = ApiError;
})(window);
