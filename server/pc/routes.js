'use strict';
const fs = require('fs');
const os = require('os');
const system = require('./system');
const programs = require('./programs');
const startup = require('./startup');
const disk = require('./disk');
const pctrash = require('./pctrash');
const shell = require('./shell');
const runtimes = require('./runtimes');
const tools = require('./tools');
const browsers = require('./browsers');
const ai = require('./ai/runner');
const purpose = require('./purpose');

module.exports = function registerPcRoutes(app, wrap) {
  app.get('/api/pc/overview', wrap(async (req, res) => res.json(await system.overview())));
  app.get('/api/pc/processes', wrap(async (req, res) => res.json(await system.processes())));
  app.post('/api/pc/processes/:pid/kill', wrap(async (req, res) => res.json(await system.killProcess(req.params.pid, req.body.tree === true))));
  app.get('/api/pc/network', wrap(async (req, res) => res.json(await system.network())));
  app.get('/api/pc/security', wrap(async (req, res) => res.json(await system.security())));

  app.get('/api/pc/programs', wrap(async (req, res) => res.json(await programs.programs(req.query.refresh === '1'))));
  app.post('/api/pc/programs/uninstall', wrap(async (req, res) => res.json(await programs.uninstall(req.body.id))));
  app.get('/api/pc/icon/:key', wrap(async (req, res) => {
    const p = programs.iconPath(req.params.key);
    if (!p) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'max-age=86400');
    fs.createReadStream(p).pipe(res);
  }));

  app.get('/api/pc/startup', wrap(async (req, res) => res.json(await startup.list())));
  app.post('/api/pc/startup/toggle', wrap(async (req, res) => res.json(await startup.setEnabled(req.body.source, req.body.name, req.body.enabled === true))));

  app.get('/api/pc/fs/list', wrap(async (req, res) => res.json(await disk.listDir(req.query.path || os.homedir()))));
  // What is this file/folder? (built-in knowledge + contents + owner lookup, plus the latest AI report's view if any)
  app.get('/api/pc/fs/explain', wrap(async (req, res) => res.json(await purpose.explain(req.query.path, { peek: true, aiPurposes: ai.latestPurposes() }))));
  app.post('/api/pc/fs/explain-batch', wrap(async (req, res) => {
    const paths = (Array.isArray(req.body.paths) ? req.body.paths : []).slice(0, 800);
    const all = await purpose.explainMany(paths, { peek: req.body.peek !== false, aiPurposes: ai.latestPurposes() });
    const slim = {};
    for (const [p, x] of Object.entries(all)) slim[p] = x.error ? x : { short: x.short, kind: x.kind, criticality: x.criticality, createdBy: x.createdBy, owner: x.owner, ownerInstalled: x.ownerInstalled, orphan: x.orphan, cleanup: x.cleanup, detail: x.detail, ai: x.ai ? { short: x.ai.short } : null };
    res.json(slim);
  }));
  app.get('/api/pc/cleanup/orphans', wrap(async (req, res) => res.json(await purpose.findOrphans())));
  app.post('/api/pc/fs/open', wrap(async (req, res) => { await shell.open(req.body.path); res.json({ ok: true }); }));
  app.post('/api/pc/fs/reveal', wrap(async (req, res) => { await shell.reveal(req.body.path); res.json({ ok: true }); }));
  app.post('/api/pc/fs/terminal', wrap(async (req, res) => { await shell.terminal(req.body.path); res.json({ ok: true }); }));

  app.post('/api/pc/scan', wrap(async (req, res) => {
    const scope = req.body.scope || 'profile';
    const roots = scope === 'drive' ? ['C:\\'] : scope === 'profile' ? [os.homedir()] : [scope];
    res.json(await disk.runScan(roots));
  }));
  app.get('/api/pc/scan/status', wrap(async (req, res) => res.json(disk.status())));
  app.get('/api/pc/scan/results', wrap(async (req, res) => res.json(disk.results())));

  app.post('/api/pc/trash', wrap(async (req, res) => res.json({ results: await pctrash.moveToTrash(Array.isArray(req.body.paths) ? req.body.paths : []) })));
  app.get('/api/pc/trash', wrap(async (req, res) => res.json({ root: pctrash.TRASH_ROOT, items: pctrash.list() })));
  app.post('/api/pc/trash/empty', wrap(async (req, res) => res.json(await pctrash.empty())));
  app.post('/api/pc/trash/:id/restore', wrap(async (req, res) => res.json(await pctrash.restore(req.params.id))));
  app.post('/api/pc/trash/:id/delete', wrap(async (req, res) => res.json(await pctrash.deleteForever(req.params.id))));

  app.get('/api/pc/runtimes', wrap(async (req, res) => res.json(await runtimes.inventory(req.query.refresh === '1'))));
  app.get('/api/pc/runtimes/python/packages', wrap(async (req, res) => res.json(await runtimes.pythonPackages(req.query.exe))));
  app.get('/api/pc/runtimes/node/globals', wrap(async (req, res) => res.json(await runtimes.npmGlobals())));

  app.get('/api/pc/tools', wrap(async (req, res) => res.json(await tools.catalog())));
  app.post('/api/pc/tools/favorite', wrap(async (req, res) => res.json(tools.toggleFavorite(req.body.path, req.body.on === true))));

  app.get('/api/pc/browsers', wrap(async (req, res) => res.json(browsers.list())));
  app.post('/api/pc/browsers/manage', wrap(async (req, res) => res.json(browsers.openManage(req.body.browser, req.body.profile, req.body.extId))));

  // ---------- AI scan ----------
  app.get('/api/pc/ai/agents', wrap(async (req, res) => res.json(await ai.agents())));
  app.post('/api/pc/ai/scan', wrap(async (req, res) => res.json(await ai.start(req.body))));
  app.get('/api/pc/ai/status', wrap(async (req, res) => res.json(ai.status())));
  app.post('/api/pc/ai/cancel', wrap(async (req, res) => res.json(ai.cancel())));
  app.get('/api/pc/ai/runs', wrap(async (req, res) => res.json(ai.listRuns())));
  app.get('/api/pc/ai/runs/:id', wrap(async (req, res) => res.json(await ai.getRun(req.params.id))));
  app.get('/api/pc/ai/runs/:id/file/:name', wrap(async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-${req.params.name}"`);
    res.send(ai.readRunFile(req.params.id, req.params.name));
  }));
  app.post('/api/pc/ai/runs/:id/decision', wrap(async (req, res) => res.json(ai.setDecision(req.params.id, String(req.body.findingId || ''), req.body.state || null))));
  app.post('/api/pc/ai/import', wrap(async (req, res) => res.json(ai.importYaml(req.body.yaml, req.body.source))));
  app.get('/api/pc/ai/bundle', wrap(async (req, res) => {
    const text = await ai.bundle();
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pc-scan-prompt-and-snapshot-${new Date().toISOString().slice(0, 10)}.md"`);
    res.send(text);
  }));
};
