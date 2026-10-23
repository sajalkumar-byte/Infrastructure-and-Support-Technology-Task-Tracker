'use strict';
/* routes/team.js – the team roster.

   GET    /api/team           anyone signed in: the roster, for the Team page and Focal lists
   POST   /api/team           super admin: add a member, or update one by id
   DELETE /api/team/:id       super admin: remove a member (their items are not touched)
   POST   /api/team/rename    super admin: rename somebody on every item they are on */

const team = require('../../model/team');
const audit = require('../../model/audit');
const permissions = require('../../model/permissions');
const { readJson, sendJson, clientIp } = require('../../view/http');
const { requireUser } = require('../middleware');

function register(router) {
  router.get('/api/team', async (req, res, ctx) => {
    requireUser(ctx);
    sendJson(res, 200, { members: await team.list() });
  });

  router.post('/api/team', async (req, res, ctx) => {
    const me = requireUser(ctx);
    permissions.assert(me.role, 'manageUsers');
    const body = await readJson(req);
    const saved = await team.save({ ...body, by: me.email });
    await audit.log({ actor: me.email, role: me.role, action: body.id ? 'team.update' : 'team.add', target: saved.id, detail: saved.name, ip: clientIp(req) });
    sendJson(res, 200, saved);
  });

  router.post('/api/team/rename', async (req, res, ctx) => {
    const me = requireUser(ctx);
    permissions.assert(me.role, 'manageUsers');
    const body = await readJson(req);
    const result = await team.rename(body.from, body.to, me.email);
    await audit.log({ actor: me.email, role: me.role, action: 'team.rename', target: String(body.from || ''), detail: `${body.to} on ${result.count} item(s)`, ip: clientIp(req) });
    sendJson(res, 200, { ok: true, count: result.count });
  });

  router.delete('/api/team/:id', async (req, res, ctx) => {
    const me = requireUser(ctx);
    permissions.assert(me.role, 'manageUsers');
    const gone = await team.remove(req.params.id);
    await audit.log({ actor: me.email, role: me.role, action: 'team.remove', target: gone.id, ip: clientIp(req) });
    sendJson(res, 200, { ok: true, id: gone.id });
  });
}

module.exports = { register };
