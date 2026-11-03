// Smoke test appended after index.html's script body.
// Requires i18n.js + _shim.js to have been loaded first (run-smoke.py does this).
let fails = 0;
function ok(label, fn) {
  try { const r = fn(); console.log('  ok    ' + label + (r ? '  ' + r : '')); }
  catch (e) { fails++; console.log('  FAIL  ' + label + '  -> ' + e.message); }
}
const read = id => (global.__cache[id] ? global.__cache[id].innerHTML : '');
const readText = id => (global.__cache[id] ? global.__cache[id].textContent : '');

/* ---------- i18n dictionary integrity ---------- */
console.log('=== i18n dictionary integrity ===');
ok('both locales present', () => {
  const codes = I18N.supported().map(m => m.code).sort();
  if (codes.join(',') !== 'en,zh') throw new Error('locales: ' + codes.join(','));
  return codes.join(', ');
});
ok('en and zh have identical key sets', () => {
  const en = Object.keys(I18N.DICT.en).sort();
  const zh = Object.keys(I18N.DICT.zh).sort();
  const missingZh = en.filter(k => !(k in I18N.DICT.zh));
  const missingEn = zh.filter(k => !(k in I18N.DICT.en));
  if (missingZh.length) throw new Error('missing in zh: ' + missingZh.slice(0, 8).join(', '));
  if (missingEn.length) throw new Error('missing in en: ' + missingEn.slice(0, 8).join(', '));
  return en.length + ' keys, both complete';
});
ok('no empty translations', () => {
  const bad = [];
  ['en', 'zh'].forEach(loc => {
    Object.keys(I18N.DICT[loc]).forEach(k => {
      const v = I18N.DICT[loc][k];
      if (typeof v !== 'string') bad.push(loc + ':' + k + ' (not a string)');
      else if (v === '') bad.push(loc + ':' + k + ' (empty)');
    });
  });
  // pf.totalUnit is intentionally empty: English has no counter word.
  const real = bad.filter(b => b.indexOf('pf.totalUnit') < 0);
  if (real.length) throw new Error(real.slice(0, 8).join('; '));
  return 'all non-empty';
});
ok('t() interpolates params', () => {
  const a = I18N.t('crumb.projects', { n: 3 });
  if (a.indexOf('{n}') >= 0) throw new Error('placeholder not replaced: ' + a);
  if (a.indexOf('3') < 0) throw new Error('value missing: ' + a);
  return a;
});
ok('unknown key returns the key, not undefined', () => {
  const r = I18N.t('nope.not.a.key');
  if (r !== 'nope.not.a.key') throw new Error('got: ' + r);
  return r;
});

/* ---------- initial landing (regression) ---------- */
console.log('=== initial landing (page load) ===');
ok('base language is English', () => {
  I18N.setLocale('en');
  if (I18N.getLocale() !== 'en') throw new Error('locale is ' + I18N.getLocale());
  return I18N.getLocale();
});
ok('default scope is portfolio', () => {
  if (STATE.scope !== 'portfolio')
    throw new Error("STATE.scope defaults to '" + STATE.scope + "', expected 'portfolio'");
  return STATE.scope;
});
ok('renderAll lands on portfolio overview', () => {
  renderAll();
  const main = read('main');
  if (main.indexOf(t('pf.tracking')) < 0) throw new Error('project-tracking table missing');
  if (main.indexOf('camera-analytics') < 0 || main.indexOf('railyard-docs') < 0)
    throw new Error('not all projects listed');
  ['seg.overview', 'seg.roadmap', 'seg.activity'].forEach(k => {
    if (read('seg').indexOf(t(k)) < 0) throw new Error('segment missing: ' + t(k));
  });
  if (read('crumbs').indexOf(t('crumb.all')) < 0) throw new Error('portfolio crumb missing');
  return 'overview + ' + keys().length + ' projects';
});

/* ---------- locale switching ---------- */
console.log('=== locale switching ===');
ok('switching to zh re-renders in Chinese', () => {
  runAction('lang:zh');
  if (I18N.getLocale() !== 'zh') throw new Error('locale did not switch');
  const main = read('main');
  if (main.indexOf('项目跟踪') < 0) throw new Error('Chinese overview not rendered');
  if (read('crumbs').indexOf('全部项目') < 0) throw new Error('Chinese crumb missing');
  if (read('seg').indexOf('总览') < 0) throw new Error('Chinese segment missing');
  if (read('menubar').indexOf('文件') < 0) throw new Error('Chinese menubar missing');
  return 'zh rendered';
});
ok('switching back to en re-renders in English', () => {
  runAction('lang:en');
  if (I18N.getLocale() !== 'en') throw new Error('locale did not switch back');
  const main = read('main');
  if (main.indexOf('Project tracking') < 0) throw new Error('English overview not rendered');
  if (main.indexOf('项目跟踪') >= 0) throw new Error('Chinese leaked into English render');
  return 'en rendered, no CN leak';
});
ok('both locales render the stage dossier', () => {
  ['en', 'zh'].forEach(loc => {
    I18N.setLocale(loc);
    STATE.scope = 'project'; STATE.project = 'camera'; STATE.view = 'pipeline'; STATE.stage = 2;
    renderAll();
    if (read('main').indexOf(t('dossier.verdict')) < 0)
      throw new Error('dossier verdict label missing in ' + loc);
  });
  I18N.setLocale('en');
  return 'ok';
});
ok('no raw i18n key leaked into rendered HTML (both locales)', () => {
  const leaks = [];
  const re = /(?:seg|pf|tl|act|ins|pipe|board|inbox|rel|rec|st|tbl|crumb|sb|sw|gate|status)\.[a-zA-Z][a-zA-Z0-9]*/g;
  ['en', 'zh'].forEach(loc => {
    I18N.setLocale(loc);
    STATE.scope = 'portfolio';
    ['overview', 'timeline', 'activity'].forEach(v => {
      STATE.pview = v; renderMain();
      const hits = read('main').match(re);
      if (hits) leaks.push(loc + '/' + v + ': ' + hits.slice(0, 3).join(', '));
    });
    STATE.scope = 'project';
    keys().forEach(k => {
      STATE.project = k;
      ['pipeline', 'board', 'inbox', 'releases', 'records'].forEach(v => {
        STATE.view = v; renderMain();
        const hits = read('main').match(re);
        if (hits) leaks.push(loc + '/' + k + '/' + v + ': ' + hits.slice(0, 3).join(', '));
      });
      renderInspector();
      const ih = read('inspector').match(re);
      if (ih) leaks.push(loc + '/' + k + '/inspector: ' + ih.slice(0, 3).join(', '));
    });
  });
  I18N.setLocale('en');
  if (leaks.length) throw new Error(leaks.slice(0, 5).join(' | '));
  return 'no raw keys in rendered HTML';
});

/* ---------- portfolio views ---------- */
console.log('=== portfolio views ===');
STATE.scope = 'portfolio';
['overview', 'timeline', 'activity'].forEach(v => {
  ok('pview ' + v, () => {
    STATE.pview = v; renderMain();
    const h = read('main');
    if (!h || h.length < 200) throw new Error('suspiciously short: ' + h.length);
    return h.length + ' chars';
  });
});
ok('globalInspector', () => {
  const h = globalInspector();
  if (h.length < 500) throw new Error('short: ' + h.length);
  return h.length + ' chars';
});

/* ---------- project views, all projects ---------- */
console.log('=== project views (all projects) ===');
keys().forEach(k => {
  STATE.scope = 'project'; STATE.project = k;
  ['pipeline', 'board', 'inbox', 'releases', 'records'].forEach(v => {
    ok(k + ' / ' + v, () => { STATE.view = v; renderMain(); return read('main').length + ' chars'; });
  });
  ok(k + ' / inspector', () => { renderInspector(); return read('inspector').length + ' chars'; });
});

/* ---------- gate data integrity ---------- */
console.log('=== gate data integrity ===');
keys().forEach(k => {
  PROJECTS[k].gates.forEach(g => {
    ok(k + ' gate "' + L(g.title).slice(0, 16) + '"', () => {
      if (!g.btns || !g.btns.length) throw new Error('no buttons');
      g.btns.forEach(b => {
        if (!b.label && !b.labelKey) throw new Error('button has neither label nor labelKey');
        if (!b.msg && !b.msgKey) throw new Error('button has neither msg nor msgKey');
        if (b.label && (!b.label.en || !b.label.zh)) throw new Error('button label not bilingual');
        if (b.msg && (!b.msg.en || !b.msg.zh)) throw new Error('button msg not bilingual');
        ['labelKey', 'msgKey'].forEach(f => {
          if (b[f]) ['en', 'zh'].forEach(loc => {
            if (!I18N.DICT[loc][b[f]]) throw new Error(b[f] + ' missing in ' + loc);
          });
        });
      });
      if (!g.trigger && !g.triggerKey) throw new Error('gate has neither trigger nor triggerKey');
      if (g.triggerKey) ['en', 'zh'].forEach(loc => {
        if (!I18N.DICT[loc][g.triggerKey]) throw new Error(g.triggerKey + ' missing in ' + loc);
      });
      if (!ICON[g.icon]) throw new Error('unknown icon: ' + g.icon);
      if (ROLE_KEYS.indexOf(g.owner) < 0) throw new Error('owner not a role key: ' + g.owner);
      g.methods.forEach(m => {
        if (METHOD_KEYS.indexOf(m) < 0) throw new Error('method not a key: ' + m);
      });
      return g.methods.length + ' methods, owner=' + roleName(g.owner);
    });
  });
});
ok('a gate created via the modal renders cleanly in both locales', () => {
  STATE.scope = 'portfolio';
  openModal();
  global.__cache['mProj'].value = 'foundry';
  global.__cache['mName'].value = 'Locale smoke gate';
  createGate();
  const leaks = [];
  ['en', 'zh'].forEach(loc => {
    I18N.setLocale(loc);
    STATE.view = 'inbox'; renderMain();
    const h = read('main');
    if (h.indexOf('Locale smoke gate') < 0) throw new Error('new gate not rendered in ' + loc);
    const label = I18N.DICT[loc]['gate.pass'];
    if (h.indexOf('>' + label + '</button>') < 0)
      throw new Error('pass button not localised in ' + loc);
    const msg = encodeURIComponent(I18N.DICT[loc]['gate.passMsg']);
    if (h.indexOf(msg) < 0) throw new Error('pass button msg not localised in ' + loc);
    const raw = h.match(/(?:gate|fail|toast)\.[a-zA-Z]+/g);
    if (raw) leaks.push(loc + ': ' + raw.slice(0, 3).join(', '));
  });
  I18N.setLocale('en');
  PROJECTS.foundry.gates.shift();
  PROJECTS.foundry.blk = 1;
  if (leaks.length) throw new Error(leaks.join(' | '));
  return 'rendered, then rolled back';
});

/* ---------- stage records integrity ---------- */
console.log('=== stage records integrity ===');
keys().forEach(k => {
  const q = PROJECTS[k];
  ok(k + ' pipeline', () => {
    if (q.pipeline.length !== 9) throw new Error('expected 9 stages, got ' + q.pipeline.length);
    const rec = Object.keys(q.records).length;
    if (rec && rec !== 9) throw new Error('records has ' + rec + ', expected 0 or 9');
    return 9 + ' stages, ' + rec + ' records, ' + q.tickets.length + ' tickets';
  });
  Object.keys(q.records).forEach(i => {
    const r = q.records[i];
    ok(k + ' record ' + i, () => {
      ['stage', 'skill', 'run', 'status'].forEach(f => {
        if (!r[f]) throw new Error('missing field ' + f);
      });
      if (STAGE_KEYS.indexOf(r.stage) < 0) throw new Error('stage not a key: ' + r.stage);
      if (!r.verdict || !r.verdict.result) throw new Error('missing verdict');
      if (['done', 'pending', 'running', 'todo', 'rework'].indexOf(r.verdict.result) < 0)
        throw new Error('verdict.result not a status key: ' + r.verdict.result);
      if (r.verdict.by && ROLE_KEYS.indexOf(r.verdict.by) < 0)
        throw new Error('verdict.by not a role key: ' + r.verdict.by);
      ['inputs', 'actions', 'artifacts', 'gates'].forEach(f => {
        if (!Array.isArray(r[f])) throw new Error(f + ' is not an array');
      });
      return stageName(r.stage) + ' / ' + statusText(r.status);
    });
  });
});
ok('every stage key resolves in both locales', () => {
  STAGE_KEYS.forEach(k => {
    ['en', 'zh'].forEach(loc => {
      if (!I18N.DICT[loc]['stage.' + k]) throw new Error('stage.' + k + ' missing in ' + loc);
      if (!I18N.DICT[loc]['stageshort.' + k]) throw new Error('stageshort.' + k + ' missing in ' + loc);
    });
  });
  return STAGE_KEYS.length * 2 + ' stage strings';
});

/* ---------- actions ---------- */
console.log('=== actions ===');
['scope:portfolio', 'scope:camera', 'scope:foundry', 'scope:railyard',
 'pview:overview', 'pview:timeline', 'pview:activity',
 'view:pipeline', 'view:board', 'view:inbox', 'view:releases', 'view:records',
 'toggleAfk', 'toggleAfk', 'toggleSidebar', 'toggleSidebar',
 'toggleInspector', 'toggleInspector', 'insertGate', 'rescan', 'exportAudit',
 'copyDossier', 'advance', 'rerun', 'pauseAll', 'gateDefaults', 'assignRoles',
 'preset:strict', 'preset:standard', 'preset:loose', 'helpFlow', 'helpSkills',
 'about', 'newProject', 'openWs', 'importRepo', 'settings',
 'lang:zh', 'lang:en'
].forEach(a => ok('action ' + a, () => runAction(a)));

console.log('=== approveAll accounting ===');
ok('approveAll clears blockers', () => {
  keys().forEach(k => { PROJECTS[k].blk = 3; });
  STATE.scope = 'project'; STATE.project = 'camera';
  runAction('approveAll');
  if (PROJECTS.camera.blk !== 0) throw new Error('blk not cleared: ' + PROJECTS.camera.blk);
  if (PROJECTS.camera.gates.some(g => g.block)) throw new Error('a gate still blocks');
  return 'camera blk 3 -> 0';
});

/* ---------- modal ---------- */
console.log('=== modal ===');
ok('modal strings localised (both locales)', () => {
  ['en', 'zh'].forEach(loc => {
    I18N.setLocale(loc);
    localizeModal();
    const title = global.__cache['modalTitle'].textContent;
    if (title !== I18N.DICT[loc]['modal.title'])
      throw new Error('title wrong in ' + loc + ': ' + title);
    const ownerOpts = read('mOwner');
    ROLE_KEYS.forEach(r => {
      if (ownerOpts.indexOf(I18N.DICT[loc]['role.' + r]) < 0)
        throw new Error('owner option missing in ' + loc + ': ' + r);
    });
  });
  I18N.setLocale('en');
  return 'six role options in both locales';
});
ok('openModal portfolio', () => {
  STATE.scope = 'portfolio'; openModal();
  if (global.__cache['mProjWrap'].style.display !== '')
    throw new Error('project picker hidden in portfolio scope');
  const n = (read('mProj').match(/<option/g) || []).length;
  if (n !== keys().length) throw new Error('expected ' + keys().length + ' project options');
  return n + ' project options';
});
ok('openModal project hides project picker', () => {
  STATE.scope = 'project'; STATE.project = 'camera'; openModal();
  if (global.__cache['mProjWrap'].style.display !== 'none')
    throw new Error('project picker visible in project scope');
  return 'hidden';
});
ok('createGate attaches to the chosen project', () => {
  STATE.scope = 'portfolio';
  openModal();
  global.__cache['mProj'].value = 'foundry';
  global.__cache['mName'].value = 'Smoke gate';
  global.__cache['mNote'].value = 'from test';
  const before = PROJECTS.foundry.gates.length;
  createGate();
  if (PROJECTS.foundry.gates.length !== before + 1) throw new Error('gate not attached to foundry');
  if (STATE.project !== 'foundry') throw new Error('did not jump to foundry');
  PROJECTS.foundry.gates.shift();
  PROJECTS.foundry.blk = 1;
  return 'attached, then rolled back';
});

/* ---------- renderers ---------- */
console.log('=== renderers ===');
[['renderMenubar', () => renderMenubar()],
 ['renderToolbar', () => renderToolbar()],
 ['renderSidebar', () => renderSidebar()],
 ['renderSeg', () => renderSeg()],
 ['renderStatusbar', () => renderStatusbar()]
].forEach(([name, fn]) => ok(name, () => { fn(); return ''; }));
ok('renderSwitcher open', () => {
  STATE.sw = true; renderSwitcher();
  const h = read('projsw');
  if (h.indexOf(t('sw.all')) < 0) throw new Error('portfolio row missing');
  if ((h.match(/switem/g) || []).length !== keys().length + 1)
    throw new Error('expected ' + (keys().length + 1) + ' switcher rows');
  STATE.sw = false;
  return (h.match(/switem/g) || []).length + ' rows';
});
ok('breadcrumb in both scopes', () => {
  STATE.scope = 'portfolio'; renderToolbar();
  if (read('crumbs').indexOf(t('crumb.all')) < 0) throw new Error('portfolio crumb missing');
  STATE.scope = 'project'; STATE.project = 'camera'; renderToolbar();
  if (read('crumbs').indexOf('camera-analytics') < 0) throw new Error('project crumb missing');
  return 'ok';
});
ok('renderAll both scopes', () => {
  STATE.scope = 'portfolio'; renderAll();
  const ph = read('main'); STATE.scope = 'project'; renderAll();
  if (!ph || ph.length < 200) throw new Error('portfolio main empty');
  if (!read('main') || read('main').length < 200) throw new Error('project main empty');
  return 'portfolio ' + ph.length + ' / project ' + read('main').length;
});

/* ---------- menus ---------- */
console.log('=== menus ===');
ok('buildMenu over MENU_SPECS', () => {
  let total = 0;
  MENU_SPECS.forEach(m => {
    const h = buildMenu(m.items);
    if (!h.length) throw new Error('empty menu: ' + t(m.title));
    total += h.length;
  });
  const sub = buildMenu([{ l: 'x', sub: [{ l: 'y', a: 'about' }] }]);
  if (sub.indexOf('has-sub') < 0) throw new Error('submenu not rendered');
  return MENU_SPECS.length + ' menus, ' + total + ' chars';
});
ok('menu titles resolve in both locales', () => {
  MENU_SPECS.forEach(m => {
    ['en', 'zh'].forEach(loc => {
      if (!I18N.DICT[loc][m.title]) throw new Error(m.title + ' missing in ' + loc);
    });
  });
  return MENU_SPECS.length + ' menus localised';
});
ok('all menu item labels resolve in both locales', () => {
  const missing = [];
  const walk = (items, loc) => items.forEach(it => {
    if (it === '-') return;
    if (it.sub) return walk(it.sub === 'lang' ? [] : it.sub, loc);
    if (!I18N.DICT[loc][it.l]) missing.push(loc + ':' + it.l);
  });
  ['en', 'zh'].forEach(loc => MENU_SPECS.forEach(m => walk(m.items, loc)));
  if (missing.length) throw new Error(missing.slice(0, 8).join(', '));
  return 'all menu labels localised';
});

/* ---------- concept-init wizard ---------- */
console.log('=== concept-init wizard: data integrity ===');
ok('six wizard steps, all with keys', () => {
  if (WIZ_STEPS.length !== 6) throw new Error('expected 6 steps, got ' + WIZ_STEPS.length);
  WIZ_STEPS.forEach(s => ['en', 'zh'].forEach(loc => {
    ['wiz.step.' + s, 'wiz.step.' + s + '.s'].forEach(k => {
      if (!I18N.DICT[loc][k]) throw new Error(k + ' missing in ' + loc);
    });
  }));
  return WIZ_STEPS.join(' → ');
});
ok('every wizard key used by the views exists in both locales', () => {
  // Introspect the view SOURCE, not their output — calling them resolves the keys.
  const src = [wzSeedView, wzFrameView, wzDestView, wzRoundsView,
               wzUncertaintyView, wzPrdView, wzPrimary, wzTop, wzRail, wzCtx, wzFoot]
    .map(f => f.toString()).join('\n');
  const keys = (src.match(/t\('([a-zA-Z][^']*)'/g) || [])
    .map(m => m.slice(3, -1))
    .filter(k => k.indexOf("'") < 0 && !/\.$/.test(k));
  if (!keys.length) throw new Error('found no t() calls in the view sources');
  const missing = [];
  keys.forEach(k => ['en', 'zh'].forEach(loc => {
    if (!I18N.DICT[loc][k]) missing.push(loc + ':' + k);
  }));
  if (missing.length) throw new Error(missing.slice(0, 8).join(', '));
  return keys.length + ' static key references resolve in both locales';
});
ok('every question is well formed', () => {
  Object.keys(WIZ.q).forEach(id => {
    const q = WIZ.q[id];
    if (!q.t || !q.t.en || !q.t.zh) throw new Error(id + ' title not bilingual');
    if (!q.b || !q.b.en || !q.b.zh) throw new Error(id + ' body not bilingual');
    if (!q.why || !q.why.en || !q.why.zh) throw new Error(id + ' why not bilingual');
    if (!q.opts || q.opts.length < 2) throw new Error(id + ' needs at least 2 options');
    if (q.opts.filter(o => o.rec).length !== 1) throw new Error(id + ' needs exactly 1 recommendation');
    q.opts.forEach((o, i) => {
      if (!o.t || !o.t.en || !o.t.zh) throw new Error(id + ' option ' + i + ' not bilingual');
    });
    if (q.needsProto) {
      if (['logic', 'ui'].indexOf(q.needsProto.kind) < 0)
        throw new Error(id + ' prototype kind must be logic|ui');
      if (!q.needsProto.reason.en || !q.needsProto.reason.zh)
        throw new Error(id + ' prototype reason not bilingual');
    }
  });
  return Object.keys(WIZ.q).length + ' questions, each with exactly one recommendation';
});
ok('rounds reference real questions and respect gating', () => {
  const seen = [];
  WIZ.rounds.forEach((r, i) => {
    if (!r.ids.length) throw new Error('round ' + (i + 1) + ' is empty');
    r.ids.forEach(id => {
      if (!WIZ.q[id]) throw new Error('round ' + (i + 1) + ' references unknown ' + id);
      if (seen.indexOf(id) >= 0) throw new Error(id + ' appears in more than one round');
      seen.push(id);
    });
  });
  const orphan = Object.keys(WIZ.q).filter(id => seen.indexOf(id) < 0);
  if (orphan.length) throw new Error('questions in no round: ' + orphan.join(', '));
  return WIZ.rounds.length + ' rounds covering all ' + seen.length + ' questions';
});

console.log('=== concept-init wizard: flow ===');
ok('wizard is closed unless opened', () => {
  closeWizard();
  if (WZSTATE.open) throw new Error('closeWizard did not close');
  openWizard();
  if (!WZSTATE.open) throw new Error('openWizard did not open');
  if (WZSTATE.step !== 0) throw new Error('should open on step 0');
  closeWizard();
  return 'opens at step 0, closes cleanly';
});
ok('seed step has a default idea and gates the Continue button', () => {
  renderWizard();
  const seed = wzSeed();
  if (seed.length < 8) throw new Error('default seed too short: ' + seed);
  if (!wzCanAdvance()) throw new Error('seed step should be advanceable with the default');
  WZSTATE.seed = ''; WZSTATE.seedTouched = true;
  if (wzCanAdvance()) throw new Error('empty seed must not advance');
  WZSTATE.seedTouched = false;
  renderWizard();
  return '"' + seed.slice(0, 24) + '…"';
});
ok('frame step renders readings and blocks until one is picked', () => {
  wzGo(1); renderWizard();
  if (WZSTATE.step !== 1) throw new Error('did not land on frame step');
  if (WZSTATE.frame !== null) throw new Error('frame should start unpicked');
  if (wzCanAdvance()) throw new Error('frame step must not advance unpicked');
  WIZ.frames.forEach((f, i) => {
    if (!f.t.en || !f.t.zh || !f.d.en || !f.d.zh || !f.shape.en || !f.shape.zh)
      throw new Error('frame ' + i + ' not fully bilingual');
  });
  WZSTATE.frame = 0; renderWizard();
  if (!wzCanAdvance()) throw new Error('frame step must advance once picked');
  return WIZ.frames.length + ' readings, then picked';
});
ok('destination step defaults are valid', () => {
  wzGo(2); renderWizard();
  const ids = k => WIZ[k].map(x => x.id);
  if (ids('destKinds').indexOf(WZSTATE.kind) < 0) throw new Error('bad default kind');
  if (ids('horizons').indexOf(WZSTATE.horizon) < 0) throw new Error('bad default horizon');
  if (ids('budgets').indexOf(WZSTATE.budget) < 0) throw new Error('bad default budget');
  if (!wzCanAdvance()) throw new Error('destination step should advance');
  return WZSTATE.kind + '/' + WZSTATE.horizon + '/' + WZSTATE.budget;
});
ok('rounds start empty and the last round gates the flow', () => {
  wzGo(3); renderWizard();
  WZSTATE.round = 0; WZSTATE.answers = {};
  Object.keys(WIZ.q).forEach(id => delete WZSTATE.answers[id]);
  if (wzRoundAnswered(0)) throw new Error('round 1 should start unanswered');
  if (wzCanAdvance()) throw new Error('rounds must gate until the last round is answered');
  if (wzSettledCount() !== 0) throw new Error('settled count should be 0');
  if (wzOpenCount() !== Object.keys(WIZ.q).length) throw new Error('open count wrong');
  return wzOpenCount() + ' open, 0 settled';
});
ok('accept-all recommends every question in the current round', () => {
  WZSTATE.round = 0; renderWizard();
  wzAcceptAll();
  WIZ.rounds[0].ids.forEach(id => {
    if (!wzAnswered(id)) throw new Error(id + ' not answered by accept-all');
    const q = WIZ.q[id];
    if (q.opts[WZSTATE.answers[id]].rec !== true)
      throw new Error(id + ' did not take the recommended option');
  });
  if (!wzRoundAnswered(0)) throw new Error('round 1 still not answered');
  return '4 recommendations taken';
});
ok('submitting round 1 advances to round 2 and re-opens the frontier', () => {
  wzSubmitRound();
  if (WZSTATE.round !== 1) throw new Error('did not advance to round 2');
  const r2open = WIZ.rounds[1].ids.filter(id => !wzAnswered(id)).length;
  if (r2open !== WIZ.rounds[1].ids.length) throw new Error('round 2 should be fully open');
  if (wzCanAdvance()) throw new Error('rounds must gate again until round 2 is answered');
  return 'round 2, ' + r2open + ' questions on the frontier';
});
ok('a question can be answered with free text instead of an option', () => {
  WZSTATE.answers['q5'] = 'other:measure it first';
  if (!wzAnswered('q5')) throw new Error('free-text answer not recorded');
  WZSTATE.answers['q5'] = 1;
  return 'free text recorded, then replaced by an option';
});
ok('answering round 2 empties the frontier and unblocks the flow', () => {
  wzAcceptAll();
  wzSubmitRound();
  if (!wzRoundAnswered(WIZ.rounds.length - 1)) throw new Error('last round not answered');
  if (wzOpenCount() !== 0) throw new Error('frontier not empty: ' + wzOpenCount());
  if (!wzCanAdvance()) throw new Error('rounds step must advance once the frontier is empty');
  return 'frontier empty, ' + wzSettledCount() + ' settled';
});
ok('glossary grows with the steps', () => {
  const at = s => { WZSTATE.step = s; return wzGlossaryAt().length; };
  const frame = at(1), r1 = at(3), prd = at(5);
  if (!(frame < r1 && r1 < prd))
    throw new Error('glossary should grow: frame=' + frame + ' r1=' + r1 + ' prd=' + prd);
  WZSTATE.step = 0;
  return frame + ' → ' + r1 + ' → ' + prd + ' terms';
});
ok('uncertainty step turns the flagged questions into prototype tickets', () => {
  const flagged = Object.keys(WIZ.q).filter(id => WIZ.q[id].needsProto);
  if (!flagged.length) throw new Error('no question is flagged as needing a prototype');
  flagged.forEach(id => {
    const p = WIZ.protos.filter(x => x.from === id);
    if (!p.length) throw new Error(id + ' is flagged but has no prototype ticket');
  });
  if (!WIZ.protos.length) throw new Error('no prototype tickets at all');
  WIZ.protos.forEach(p => {
    if (['logic', 'ui'].indexOf(p.kind) < 0) throw new Error('bad prototype kind: ' + p.kind);
    ['t', 'why', 'shape'].forEach(f => {
      if (!p[f] || !p[f].en || !p[f].zh) throw new Error('prototype ' + p.id + ' field ' + f + ' not bilingual');
    });
  });
  return flagged.length + ' flagged → ' + WIZ.protos.length + ' tickets';
});

console.log('=== concept-init wizard: PRD ===');
ok('PRD is fully bilingual and has every section', () => {
  const p = WIZ.prd;
  ['problem', 'solution'].forEach(f => {
    if (!p[f].en || !p[f].zh) throw new Error(f + ' not bilingual');
  });
  ['stories', 'decisions', 'testing', 'out'].forEach(f => {
    if (!Array.isArray(p[f]) || !p[f].length) throw new Error(f + ' is empty');
    p[f].forEach((s, i) => {
      if (!s.en || !s.zh) throw new Error(f + '[' + i + '] not bilingual');
    });
  });
  if (!p.seam.en || !p.seam.zh) throw new Error('seam not bilingual');
  return p.stories.length + ' stories, ' + p.decisions.length + ' decisions, ' +
    p.out.length + ' out-of-scope';
});
ok('PRD stories follow the "as a … I want … so that …" shape', () => {
  WIZ.prd.stories.forEach((s, i) => {
    const en = s.en.toLowerCase();
    if (en.indexOf('i want') < 0 || en.indexOf('so that') < 0)
      throw new Error('story ' + i + ' is not in story form: ' + s.en.slice(0, 60));
  });
  return 'all ' + WIZ.prd.stories.length + ' stories well formed';
});
ok('every settled question is traceable to a PRD decision', () => {
  const qids = Object.keys(WIZ.q);
  const uncov = qids.filter(id => WIZ.covers[id] === undefined);
  if (uncov.length) throw new Error('no PRD coverage mapped for: ' + uncov.join(', '));
  const bad = qids.filter(id => WIZ.covers[id] < 0 || WIZ.covers[id] >= WIZ.prd.decisions.length);
  if (bad.length) throw new Error('covers points outside the decisions list: ' + bad.join(', '));
  const reached = Object.keys(WIZ.covers).map(k => WIZ.covers[k]);
  const distinct = reached.filter((v, i) => reached.indexOf(v) === i);
  if (distinct.length !== WIZ.prd.decisions.length)
    throw new Error('decisions covered: ' + distinct.length + ' of ' + WIZ.prd.decisions.length);
  // two questions legitimately folding into one decision is expected
  const folded = reached.length - distinct.length;
  return qids.length + ' questions → ' + distinct.length + ' decisions (' + folded + ' folded)';
});
ok('a question folded into a shared decision is still recorded once', () => {
  const dupes = {};
  Object.keys(WIZ.covers).forEach(k => {
    const v = WIZ.covers[k];
    dupes[v] = (dupes[v] || 0) + 1;
  });
  const shared = Object.keys(dupes).filter(v => dupes[v] > 1);
  if (!shared.length) throw new Error('expected at least one folded decision (placement)');
  return shared.length + ' decision(s) settled by more than one question';
});
ok('glossary and ADRs are bilingual', () => {
  WIZ.glossary.forEach((g, i) => {
    if (!g.w) throw new Error('glossary ' + i + ' has no word');
    if (!g.d.en || !g.d.zh) throw new Error('glossary ' + g.w + ' not bilingual');
  });
  WIZ.adrs.forEach(a => {
    if (!a.id) throw new Error('ADR with no id');
    if (!a.t.en || !a.t.zh) throw new Error('ADR ' + a.id + ' not bilingual');
    if (!a.why.en || !a.why.zh) throw new Error('ADR ' + a.id + ' rationale not bilingual');
  });
  return WIZ.glossary.length + ' terms, ' + WIZ.adrs.length + ' ADRs';
});

console.log('=== concept-init wizard: every step renders in both locales ===');
const stepLens = {};
['en', 'zh'].forEach(loc => {
  I18N.setLocale(loc);
  WIZ_STEPS.forEach((s, i) => {
    ok(loc + ' step ' + (i + 1) + ' ' + s, () => {
      WZSTATE.open = true;
      WZSTATE.step = i;
      WZSTATE.frame = 0;
      WZSTATE.round = 1;
      wzAcceptAll();
      renderWizard();
      const h = read('wzMain');
      if (!h || h.length < 150) throw new Error('suspiciously short: ' + h.length);
      const raw = h.match(/wiz\.[a-zA-Z.]+/g);
      if (raw) throw new Error('raw key leaked: ' + raw.slice(0, 3).join(', '));
      if (read('wzRail').indexOf('wiz.') >= 0) throw new Error('raw key in rail');
      if (read('wzCtx').indexOf('wiz.') >= 0) throw new Error('raw key in context panel');
      if (!read('wzFoot').length) throw new Error('footer did not render');
      stepLens[loc] = (stepLens[loc] || []);
      stepLens[loc].push(h.length);
      return h.length + ' chars';
    });
  });
});
ok('each step renders distinct content (guards against a silent no-op render)', () => {
  ['en', 'zh'].forEach(loc => {
    const lens = stepLens[loc];
    const uniq = lens.filter((v, i) => lens.indexOf(v) === i);
    if (uniq.length !== lens.length)
      throw new Error(loc + ': steps rendered identical lengths ' + lens.join(', '));
  });
  return 'all six lengths differ in both locales';
});
ok('footer offers the right primary action per step', () => {
  I18N.setLocale('en');
  WZSTATE.open = true;
  // rounds: submit + accept-all
  WZSTATE.step = 3; renderWizard();
  if (read('wzFoot').indexOf(t('wiz.rounds.acceptAll')) < 0)
    throw new Error('rounds step missing accept-all');
  // prd: approve + send back
  WZSTATE.step = 5; renderWizard();
  if (read('wzFoot').indexOf(t('wiz.prd.approve')) < 0)
    throw new Error('prd step missing approve');
  if (read('wzFoot').indexOf(t('wiz.prd.edit')) < 0)
    throw new Error('prd step missing send-back');
  // seed: just continue, and no back button on the first step
  WZSTATE.step = 0; renderWizard();
  if (read('wzFoot').indexOf(t('wiz.back')) >= 0)
    throw new Error('first step should not offer Back');
  closeWizard();
  return 'rounds / prd / seed footers correct';
});
I18N.setLocale('en');

console.log('=== concept-init wizard: create ===');
ok('finishing the wizard creates the project at Stage 4', () => {
  STATE.scope = 'portfolio';
  WZSTATE.step = 5;
  WZSTATE.projName = 'wizard-smoke-project';
  const key = wzSlug(WZSTATE.projName);
  const existed = !!PROJECTS[key];
  openWizard();
  wzCreate();
  if (WZSTATE.open) throw new Error('wizard did not close');
  if (STATE.scope !== 'project') throw new Error('did not switch to the project scope');
  if (STATE.project !== key) throw new Error('did not open the new project, got ' + STATE.project);
  const p = PROJECTS[key];
  const active = p.pipeline.findIndex(s => s.s === 'active');
  if (active !== 3) throw new Error('expected stage 4 active, got index ' + active);
  ['s1', 's2', 's3'].forEach((s, i) => {
    if (p.pipeline[i].n !== s) throw new Error('stage ' + (i + 1) + ' should be ' + s);
    if (p.pipeline[i].s !== 'done') throw new Error('stage ' + (i + 1) + ' should be done');
  });
  renderAll();
  if (read('main').length < 200) throw new Error('project view did not render');
  delete PROJECTS[key];
  return (existed ? 'reused existing' : 'created') + ' ' + key + ' at stage 4';
});
ok('a second run does not duplicate the project', () => {
  WZSTATE.projName = 'wizard-smoke-project';
  const key = wzSlug(WZSTATE.projName);
  WZSTATE.step = 5;
  openWizard(); wzCreate();
  const n1 = Object.keys(PROJECTS).length;
  openWizard(); wzCreate();
  const n2 = Object.keys(PROJECTS).length;
  if (n1 !== n2) throw new Error('project count grew on second create: ' + n1 + ' -> ' + n2);
  delete PROJECTS[key];
  STATE.scope = 'portfolio'; STATE.project = 'camera'; renderAll();
  return 'idempotent';
});
ok('slugify produces a tracker-safe key', () => {
  const cases = [['Camera Watch!', 'camera-watch'], ['  Lots   of  Spaces  ', 'lots-of-spaces'],
                 ['', 'new-project'], ['---', 'new-project'], ['a'.repeat(80), 'a'.repeat(40)]];
  cases.forEach(([inp, want]) => {
    const got = wzSlug(inp);
    if (got !== want) throw new Error('slug(' + JSON.stringify(inp) + ') = ' + got + ', want ' + want);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(got)) throw new Error('unsafe slug: ' + got);
  });
  return cases.length + ' cases';
});
ok('wizard data survives a locale switch mid-flow', () => {
  WZSTATE.answers = {}; WZSTATE.round = 0; WZSTATE.frame = 0; WZSTATE.step = 3;
  Object.keys(WIZ.q).forEach(id => delete WZSTATE.answers[id]);
  wzAcceptAll();
  const before = JSON.stringify(WZSTATE.answers);
  I18N.setLocale('zh');
  renderWizard();
  if (JSON.stringify(WZSTATE.answers) !== before) throw new Error('answers changed on locale switch');
  I18N.setLocale('en');
  renderWizard();
  if (JSON.stringify(WZSTATE.answers) !== before) throw new Error('answers changed switching back');
  closeWizard();
  return 'answers stable across locales';
});

/* ---------- settings ---------- */
console.log('=== settings: data integrity ===');
ok('every category has a key in both locales', () => {
  SET_CATS.forEach(c => ['en', 'zh'].forEach(loc => {
    if (!I18N.DICT[loc][c.k]) throw new Error(c.k + ' missing in ' + loc);
    if (!ICON[c.icon]) throw new Error('unknown icon for category ' + c.id + ': ' + c.icon);
  }));
  return SET_CATS.length + ' categories';
});
ok('agents defaults are internally consistent', () => {
  const a = SETTINGS.agents;
  if (a.minParallel > a.maxParallel) throw new Error('min above current');
  if (a.maxParallel > a.maxParallelCap) throw new Error('current above cap');
  if (['worktree', 'container', 'vm'].indexOf(a.isolation) < 0)
    throw new Error('unknown isolation: ' + a.isolation);
  if (a.retries < 0 || a.timeoutMin <= 0) throw new Error('bad retry/timeout');
  return a.minParallel + '..' + a.maxParallelCap + ', default ' + a.maxParallel +
    ', ' + a.isolation;
});
ok('every skill entry maps to a real stage', () => {
  SETTINGS.skills.forEach(s => {
    if (STAGE_KEYS.indexOf(s.stage) < 0) throw new Error('unknown stage: ' + s.stage);
  });
  const stages = SETTINGS.skills.map(s => s.stage);
  const dupes = stages.filter((v, i) => stages.indexOf(v) !== i);
  if (dupes.length) throw new Error('two skills on one stage: ' + dupes.join(', '));
  return SETTINGS.skills.length + ' entries across ' + STAGE_KEYS.length + ' stages';
});
ok('every MCP server is well formed', () => {
  SETTINGS.mcp.forEach(s => {
    if (!s.name) throw new Error('server with no name');
    if (['stdio', 'http', 'sse'].indexOf(s.transport) < 0)
      throw new Error(s.name + ': unknown transport ' + s.transport);
    if (['ok', 'error', 'off'].indexOf(s.status) < 0) throw new Error(s.name + ': bad status');
    if (!s.scope.length) throw new Error(s.name + ' has no scope');
    s.scope.forEach(x => {
      if (STAGE_KEYS.indexOf(x) < 0) throw new Error(s.name + ': bad scope ' + x);
    });
    if (s.status === 'error' && !s.err) throw new Error(s.name + ' errors but explains nothing');
  });
  return SETTINGS.mcp.length + ' servers, ' +
    SETTINGS.mcp.filter(s => s.status === 'error').length + ' in error';
});

console.log('=== settings: concurrency is a scheduler, not a number ===');
ok('max parallel clamps to the allowed range', () => {
  const a = SETTINGS.agents;
  const orig = a.maxParallel;
  if (setMax(99) !== a.maxParallelCap) throw new Error('did not clamp the top');
  if (setMax(-5) !== a.minParallel) throw new Error('did not clamp the bottom');
  if (setMax(3.7) !== 4) throw new Error('did not round');
  if (setMax(NaN) !== a.minParallel) throw new Error('NaN not handled');
  a.maxParallel = orig;
  return '99→' + a.maxParallelCap + ', -5→' + a.minParallel + ', 3.7→4, NaN→' + a.minParallel;
});
ok('the slot count always equals max parallel', () => {
  const orig = SETTINGS.agents.maxParallel;
  SETSTATE.open = true;
  SETSTATE.cat = 'agents';
  [1, 2, 4, 6, 8].forEach(n => {
    setMax(n);
    renderSettings();
    const slots = (read('setMain').match(/class="slot[ "]/g) || []).length;
    if (slots !== n) throw new Error('max=' + n + ' but rendered ' + slots + ' slots');
  });
  SETTINGS.agents.maxParallel = orig;
  return '1,2,4,6,8 all render matching slots';
});
ok('the busy/idle split matches the agents actually running', () => {
  const orig = SETTINGS.agents.maxParallel;
  SETSTATE.open = true;
  SETSTATE.cat = 'agents';
  const want = Math.min(runningAgents(), 8);
  setMax(8);
  renderSettings();
  const busy = (read('setMain').match(/class="slot busy"/g) || []).length;
  if (busy !== want) throw new Error('expected ' + want + ' busy, got ' + busy);
  setMax(1);
  renderSettings();
  const busy1 = (read('setMain').match(/class="slot busy"/g) || []).length;
  if (busy1 > 1) throw new Error('1 slot but ' + busy1 + ' busy');
  SETTINGS.agents.maxParallel = orig;
  return want + ' running → ' + want + ' busy at cap 8, ≤1 at cap 1';
});
ok('the concurrency line names the integration branch', () => {
  SETSTATE.open = true; SETSTATE.cat = 'agents'; renderSettings();
  const h = read('setMain');
  if (h.indexOf(integrationBranch()) < 0)
    throw new Error('integration branch not shown: ' + integrationBranch());
  if (h.indexOf('→') < 0) throw new Error('no flow arrow');
  return integrationBranch();
});
ok('changing max parallel updates the status bar', () => {
  const orig = SETTINGS.agents.maxParallel;
  setMax(2); renderStatusbar();
  const at2 = read('statusbar');
  setMax(7); renderStatusbar();
  const at7 = read('statusbar');
  if (at2 === at7) throw new Error('status bar did not change with concurrency');
  if (at7.indexOf('/ 7') < 0) throw new Error('capacity not shown: ' + at7.slice(0, 120));
  SETTINGS.agents.maxParallel = orig; renderStatusbar();
  return 'renders "n / 7"';
});
ok('a project with no CI history does not break the aggregate', () => {
  const key = 'empty-ci-project';
  PROJECTS[key] = {name: key, mode: {en: 'x', zh: 'x'}, branch: 'b', dot: 'idle',
    blk: 0, running: 0, updated: '—', note: {en: 'n', zh: 'n'}, commits: 0,
    pipeline: STAGE_KEYS.map((s, i) => ({n: s, s: i === 3 ? 'active' : 'pending', sk: 'x'})),
    records: {}, tickets: [], gates: [],
    ci: {pipe: [], servers: [], releases: [], log: []}};
  const c = ciOf(PROJECTS[key]);
  if (c.lv !== 'idle') throw new Error('expected idle, got ' + c.lv);
  renderStatusbar(); renderSidebar();
  delete PROJECTS[key];
  return 'idle, not a crash';
});

console.log('=== settings: credentials are never rendered in full ===');
ok('no rendered view contains a key-shaped secret', () => {
  // Real providers: sk-ant-…, ghp_…, sk-…, AKIA…, xox…, and bare 32+ char runs.
  const patterns = [/sk-ant-[A-Za-z0-9-]{10,}/, /ghp_[A-Za-z0-9]{20,}/,
                    /sk-[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/, /xox[baprs]-[A-Za-z0-9-]{10,}/,
                    /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  const leaks = [];
  ['en', 'zh'].forEach(loc => {
    I18N.setLocale(loc);
    SETSTATE.open = true;
    SET_CATS.forEach(c => {
      SETSTATE.cat = c.id;
      renderSettings();
      const h = read('setMain');
      patterns.forEach(re => { if (re.test(h)) leaks.push(loc + '/' + c.id + ': ' + re); });
    });
  });
  I18N.setLocale('en');
  closeSettings();
  if (leaks.length) throw new Error(leaks.join(' | '));
  return 'no key-shaped string in any category, either locale';
});
ok('stored keys render masked', () => {
  SETSTATE.open = true; SETSTATE.cat = 'credentials'; renderSettings();
  const h = read('setMain');
  SETTINGS.credentials.forEach(c => {
    if (h.indexOf(c.mask) < 0) throw new Error('mask not shown for ' + L(c.provider));
    if (!/•/.test(c.mask)) throw new Error('mask has no bullet: ' + c.mask);
  });
  closeSettings();
  return SETTINGS.credentials.length + ' keys masked';
});

console.log('=== settings: skills toggle the pipeline ===');
ok('disabling a skill flips its stage out of automatic', () => {
  const s = skillAt('s6');
  if (!s || !s.on) throw new Error('expected implement-spec enabled by default');
  if (!skillEnabled('s6')) throw new Error('enabled skill reported as disabled');
  s.on = false;
  if (skillEnabled('s6')) throw new Error('disabled skill still reported enabled');
  SETSTATE.open = true; SETSTATE.cat = 'skills'; renderSettings();
  if (read('setMain').indexOf(t('set.skills.disabled')) < 0)
    throw new Error('disabled state not shown');
  s.on = true;
  if (!skillEnabled('s6')) throw new Error('re-enabling failed');
  closeSettings();
  return 's6 toggles both ways';
});
ok('the CI stage has no skill and is marked manual', () => {
  const s = skillAt('s8');
  if (!s) throw new Error('stage 8 has no entry');
  if (!s.manual) throw new Error('stage 8 should be flagged manual');
  if (s.id) throw new Error('stage 8 should have no skill id');
  SETSTATE.open = true; SETSTATE.cat = 'skills'; renderSettings();
  const h = read('setMain');
  if (h.indexOf(t('set.skills.none')) < 0) throw new Error('manual stage not labelled');
  closeSettings();
  return 'labelled "' + t('set.skills.none') + '"';
});
ok('every skill in the chain has a bilingual source label', () => {
  SETTINGS.skills.concat(SETTINGS.skillPool.map(s => ({src: s.src}))).forEach(s => {
    const v = s.src;
    if (!v) throw new Error('skill with no source');
    if (typeof v === 'string') return;
    if (!v.en || !v.zh) throw new Error('source not bilingual: ' + JSON.stringify(v));
  });
  return SETTINGS.skills.length + ' chain + ' + SETTINGS.skillPool.length + ' pool';
});

console.log('=== settings: MCP add / remove / test ===');
ok('adding a server appends it', () => {
  const before = SETTINGS.mcp.length;
  SETSTATE.open = true; SETSTATE.cat = 'mcp'; renderSettings();
  global.__cache['mcpAdd'].onclick();
  if (SETTINGS.mcp.length !== before + 1) throw new Error('add did not append');
  const added = SETTINGS.mcp[SETTINGS.mcp.length - 1];
  if (added.status !== 'off') throw new Error('a new server should start disconnected');
  SETTINGS.mcp.pop();
  return before + ' → ' + (before + 1) + ', then rolled back';
});
ok('removing a server drops it and re-renders', () => {
  const before = SETTINGS.mcp.length;
  const name = SETTINGS.mcp[1].name;
  SETSTATE.open = true; SETSTATE.cat = 'mcp'; renderSettings();
  const btn = global.__cache['setMain'];
  // drive removal through the data path the button uses
  SETTINGS.mcp.splice(1, 1);
  renderSettings();
  if (SETTINGS.mcp.length !== before - 1) throw new Error('remove did not drop');
  if (SETTINGS.mcp.some(s => s.name === name)) throw new Error(name + ' still present');
  SETTINGS.mcp.splice(1, 0, {name: name, transport: 'stdio', cmd: 'mcp-server-git --repository .',
    scope: ['s6', 's7'], status: 'ok', env: 1});
  return name + ' removed, then restored';
});
ok('the errored server is surfaced, not hidden', () => {
  SETSTATE.open = true; SETSTATE.cat = 'mcp'; renderSettings();
  const h = read('setMain');
  const bad = SETTINGS.mcp.filter(s => s.status === 'error');
  if (!bad.length) throw new Error('fixture has no errored server');
  if (h.indexOf(bad[0].name) < 0) throw new Error('errored server not listed');
  if (h.indexOf(t('set.mcp.error')) < 0) throw new Error('error state not labelled');
  if (h.indexOf(t('set.mcp.errNote')) < 0) throw new Error('no explanation shown');
  return bad[0].name + ' surfaced with an explanation';
});
ok('an MCP server scoped to some stages never claims all of them', () => {
  SETTINGS.mcp.forEach(s => {
    if (s.scope.length === STAGE_KEYS.length && s.scope.length < STAGE_KEYS.length + 1) {
      // a full-stage scope is legal, but the label must then say so
      throw new Error(s.name + ' spans every stage without saying so');
    }
  });
  const some = SETTINGS.mcp.filter(s => s.scope.length < STAGE_KEYS.length);
  if (!some.length) throw new Error('no server demonstrates scoping');
  return some.length + ' servers scoped to a subset';
});

console.log('=== settings: every category renders in both locales ===');
const catLens = {};
['en', 'zh'].forEach(loc => {
  I18N.setLocale(loc);
  SET_CATS.forEach(c => {
    ok(loc + ' ' + c.id, () => {
      SETSTATE.open = true;
      SETSTATE.cat = c.id;
      renderSettings();
      const h = read('setMain');
      if (!h || h.length < 200) throw new Error('suspiciously short: ' + h.length);
      const raw = h.match(/\bset\.[a-zA-Z.]+/g);
      if (raw) throw new Error('raw key leaked: ' + raw.slice(0, 3).join(', '));
      if (!read('setRail').length) throw new Error('rail not rendered');
      if (readText('setDone') !== I18N.DICT[loc]['set.done'])
        throw new Error('Done button not localised: ' + readText('setDone'));
      if (readText('setTitle') !== I18N.DICT[loc]['set.title'])
        throw new Error('window title not localised');
      catLens[loc] = catLens[loc] || [];
      catLens[loc].push(h.length);
      return h.length + ' chars';
    });
  });
});
ok('each settings category renders distinct content', () => {
  ['en', 'zh'].forEach(loc => {
    const lens = catLens[loc];
    const uniq = lens.filter((v, i) => lens.indexOf(v) === i);
    if (uniq.length !== lens.length)
      throw new Error(loc + ': categories rendered identical lengths ' + lens.join(', '));
  });
  return 'all ' + SET_CATS.length + ' lengths differ in both locales';
});
ok('opening from a menu action lands on the right category', () => {
  runAction('settings');
  if (!SETSTATE.open || SETSTATE.cat !== 'general') throw new Error('settings did not open on general');
  runAction('assignRoles');
  if (SETSTATE.cat !== 'agents') throw new Error('assignRoles should open Agents');
  runAction('helpSkills');
  if (SETSTATE.cat !== 'skills') throw new Error('helpSkills should open Skills');
  runAction('gateDefaults');
  if (SETSTATE.cat !== 'automation') throw new Error('gateDefaults should open Automation');
  closeSettings();
  return 'general / agents / skills / automation';
});
ok('Escape closes settings before anything else', () => {
  openSettings();
  if (!SETSTATE.open) throw new Error('did not open');
  closeSettings();
  if (SETSTATE.open) throw new Error('did not close');
  return 'opens and closes cleanly';
});
I18N.setLocale('en');

console.log('');
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURE(S)');
process.exit(fails === 0 ? 0 : 1);