#!/usr/bin/env python3
"""Wire web/index.html to the live API.

The prototype's design system and renderers are kept exactly as they were: they
were validated over ten iterations and rewriting them would throw that away. What
changes is where the data comes from, what a gate button does, and that the wizard
and settings write through to the server.

Run from the repository root:  python tools/wire-web.py
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAGE = os.path.join(ROOT, 'web', 'index.html')
I18N = os.path.join(ROOT, 'web', 'i18n.js')


def replace_once(src: str, old: str, new: str, label: str) -> str:
    if old not in src:
        raise SystemExit(f'anchor not found: {label}')
    return src.replace(old, new, 1)


def insert_before_close(src: str, body: str) -> str:
    """Add a function inside the module, not after it.

    `src.rstrip() + body` lands after `</script>`, which is HTML — the function
    never enters JavaScript, and every caller fails at run time with
    "not defined". The insertion point is the last script's closing tag, which is
    the only thing guaranteed to be there whenever this runs.
    """
    at = src.rfind('</script>')
    if at < 0:
        raise SystemExit('no closing script tag to insert before')
    return src[:at] + body + '\n' + src[at:]


def replace_function(src: str, header: str, body: str, label: str) -> str:
    """Replace a whole top-level function, matched by brace counting.

    Replacing only the header leaves the original body orphaned, which produces a
    top-level `return` and a syntax error — and the error points at the new code,
    not at the edit that caused it. Counting braces avoids the whole class.
    """
    start = src.find(header)
    if start < 0:
        raise SystemExit(f'function not found: {label} ({header})')
    depth = 0
    i = start + len(header) - 1  # position of the opening brace
    while i < len(src):
        ch = src[i]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return src[:start] + body + src[i + 1:]
        i += 1
    raise SystemExit(f'unbalanced braces for {label}')


def patch(src: str) -> str:
    # 1. The main script becomes a module so it can import the adapter.
    src = replace_once(
        src,
        '<script src="i18n.js"></script>\n<script>\n',
        '<script src="i18n.js"></script>\n'
        '<script type="module">\n'
        "import * as API from './api.js';\n"
        "import * as FLOW from './session.js';\n",
        'script open tag',
    )

    # 2. Fixtures become empty state the bootstrap fills.
    src = replace_once(
        src,
        '/* PROJECTS_FROM_API */',
        '/* Filled at boot from GET /api/projects. Empty until then, so a dead\n'
        '   backend renders an empty board rather than a fiction. */\n'
        'let PROJECTS = {};\n'
        'let LOADED = false;\n'
        'let LOAD_ERROR = null;\n'
        '/* The concept-init flow. Rebuilt from the session on every read, so a\n'
        '   refresh lands in the same place rather than starting over. */\n'
        'let FLOWSTATE = Object.assign({ open: false }, FLOW.blankFlow());\n'
        '/* Which feature of which project is selected. Kept in the URL so a\n'
        '   refresh returns to the same place. */\n'
        'let FEATURE_SEL = readSelectionFromHash();',
        'PROJECTS marker',
    )

    # 3. Local settings, filled from the server at boot.
    src = replace_once(
        src,
        '/* SETTINGS_LOCAL */',
        SETTINGS_JS,
        'SETTINGS marker',
    )

    # 4. Gate buttons carry the outcome and the qualified ref, so a click can be
    #    recorded instead of only simulated.
    src = replace_once(
        src,
        "'<div class=\"gbtns\">'+g.btns.map((b,i)=>'<button class=\"btn'+(i===0?' btn-p':'')+'\" data-msg=\"'+\n"
        "          encodeURIComponent(btnMsg(b))+'\">'+btnLabel(b)+'</button>').join('')+'</div>'+",
        "'<div class=\"gbtns\">'+g.btns.map((b,i)=>'<button class=\"btn'+(i===0?' btn-p':'')+'\" data-msg=\"'+\n"
        "          encodeURIComponent(btnMsg(b))+'\"'+\n"
        "          (b.act?' data-outcome=\"'+b.act.outcome+'\"':'')+\n"
        "          (g.ref?' data-ref=\"'+g.ref+'\"':'')+'>'+btnLabel(b)+'</button>').join('')+'</div>'+",
        'gate button template',
    )

    # 5. Gate clicks write through the API.
    src = replace_once(
        src,
        "  document.querySelectorAll('#main .gate .gbtns .btn').forEach(b=>b.onclick=()=>{\n"
        "    const card=b.closest('.gate');",
        LIVE_HANDLER,
        'gate click handler',
    )

    # 6. A visible Settings entry. The menu bar was the only way in, and the menu
    #    bar is not where anyone looks for it.
    src = replace_once(
        src,
        '<button class="iconbtn" id="inspToggle" title="inspector">',
        '<button class="iconbtn" id="setToggle" title="settings">'
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" '
        'stroke-linecap="round" stroke-linejoin="round">'
        '<circle cx="8" cy="8" r="2.4"/>'
        '<path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1"/>'
        '</svg></button>\n        '
        '<button class="iconbtn" id="inspToggle" title="inspector">',
        'settings button',
    )

    # 7. Settings rows for the real categories: the chain read from disk, MCP from
    #    config, and a probe that actually runs. Each function is replaced whole —
    #    replacing only the header would orphan the original body.
    for header, body in REAL_SETTINGS_FUNCS + SETTINGS_VIEW_FUNCS:
        src = (
            replace_function(src, header, body, header)
            if header in src
            else insert_before_close(src, body)
        )

    # 8. The wizard's final action writes to disk.
    src = replace_function(src, 'function wzCreate(){', WZ_CREATE, 'wizard create')

    # 9. The wizard picks a target repository and a feature slug.
    src = replace_once(
        src,
        "  const slug=wzSlug(WZSTATE.projName);\n"
        "  h+='<div class=\"field\"><label>'+t('wiz.prd.project')+'</label>'+\n"
        "    '<input type=\"text\" id=\"wzProjName\" value=\"'+WZSTATE.projName+'\">'+\n"
        "    '<div class=\"hint\">'+t('wiz.prd.projectHint',{slug:slug})+'</div></div>';",
        WZ_PRD_TARGET,
        'wizard target picker',
    )


    # 12. The concept-init flow. Replaces the prototype's five-step wizard with the
    #     three-step flow the session actually drives: idea, rounds, PRD. The two
    #     dropped steps asked the human to pre-empt the grilling.
    src = replace_function(src, 'function renderWizard(){', WIZARD_FLOW, 'wizard flow')
    for header, body in WIZARD_HELPERS + WIZARD_HELPERS_EXTRA:
        # A replacement body has to be a whole function. One that is only a
        # prefix leaves the original's braces dangling, and the symptom appears
        # hundreds of lines away as an unrelated syntax error.
        depth = body.count('{') - body.count('}')
        if depth != 0:
            raise SystemExit(
                f'body for {header!r} is not brace-balanced (depth {depth}); '
                'a replacement must be a complete function'
            )
        if header in src:
            src = replace_function(src, header, body, header)
        else:
            src = insert_before_close(src, body)

    # 13. The sidebar's New project opens the flow.
    src = replace_once(src, 'onclick="openWizard()"', 'onclick="openFlow()"', 'new project cta')
    src = replace_once(src, "case 'newProject':openWizard();return;", "case 'newProject':openFlow();return;", 'new project action')


    # 14. Inline handlers need their functions on the global object.
    #
    #     This is the bug the module switch introduced and nothing caught: in a
    #     classic script, a top-level `function f(){}` becomes a global, so
    #     `onclick="f()"` works. In a module it does not — module scope is not
    #     global — so every inline handler in the page threw a ReferenceError and
    #     the button did nothing at all. "No reaction" was the whole symptom.
    #
    #     The list is computed from the page rather than hand-written, so a new
    #     inline handler is published by the next run. check-web.py asserts the
    #     invariant at runtime.
    needs = sorted({
        fn
        for attr in re.findall(r'on\w+="([^"]*)"', src)
        for fn in re.findall(r'([A-Za-z_$][\w$]*)\s*\(', attr)
    })
    published = [fn for fn in needs if re.search(r'function\s+' + fn + r'\s*\(', src)]
    src = insert_before_close(
        src,
        '\n/* The inline-handler surface. See the note in tools/wire-web.py: module\n'
        '   scope is not global, so anything an `on*` attribute calls must be\n'
        '   published deliberately. */\n' +
        ''.join(f'globalThis.{fn} = {fn};\n' for fn in published),
    )


    # 15. Two pieces of chrome the page needs once it is talking to a server: a
    #     connection banner, and a notice that explains a dead page.
    #
    #     Everything this app does needs the local server: it reads repositories
    #     off disk and runs an agent. Opened straight from the filesystem, module
    #     imports fail on the browser's own same-origin rules and absolutely
    #     nothing renders — a blank page with a clean console, which reads as "the
    #     app is broken" rather than "the app is not running". boot() takes the
    #     notice down once it has data, and writes the reason into it when it does
    #     not.
    src = replace_once(
        src,
        '<body>\n<div class="app">',
        '<body>\n'
        '<div id="bootNotice" class="boot-notice">\n'
        '  <div class="bn-card">\n'
        '    <h1>Serve the app, do not open the file</h1>\n'
        '    <p>This page reads repositories from disk and runs an agent, so it needs\n'
        '       the local server. Opened as a file, the browser blocks its modules and\n'
        '       nothing renders at all.</p>\n'
        '    <pre>npm run serve</pre>\n'
        '    <p>Then open <b>http://127.0.0.1:4173</b>. If the server is running and\n'
        '       you still see this, the reason is below.</p>\n'
        '    <p id="bootNoticeDetail" class="bn-detail"></p>\n'
        '  </div>\n'
        '</div>\n'
        '<div class="app">',
        'boot notice',
    )

    src = replace_once(
        src,
        '<div class="cols">',
        '<div class="conn-banner" id="connection"></div>\n      <div class="cols">',
        'connection banner',
    )

    src = replace_once(
        src,
        '  .cbody{flex:1;overflow-y:auto;padding:20px 24px 28px}',
        '  .cbody{flex:1;overflow-y:auto;padding:20px 24px 28px}\n'
        '  .conn-banner{display:none;padding:9px 24px;font-size:12.5px;\n'
        '    background:var(--red-t);color:var(--red-d);border-bottom:.5px solid var(--sep)}\n'
        '  .conn-banner.on{display:block}\n'
        '  .boot-notice{position:fixed;inset:0;z-index:200;display:flex;align-items:center;\n'
        '    justify-content:center;padding:24px;background:var(--content)}\n'
        '  .boot-notice.gone{display:none}\n'
        '  .bn-card{max-width:520px;background:#fff;border:.5px solid var(--sep);\n'
        '    border-radius:var(--r4);box-shadow:var(--sh3);padding:26px 28px}\n'
        '  .bn-card h1{margin:0 0 10px;font-size:19px;font-weight:600;letter-spacing:-.02em}\n'
        '  .bn-card p{margin:0 0 12px;font-size:13px;line-height:1.65;color:var(--label-2)}\n'
        '  .bn-card pre{margin:0 0 12px;padding:10px 12px;border-radius:var(--r2);\n'
        '    background:var(--fill);font-family:var(--mono);font-size:12.5px;color:var(--label)}\n'
        '  .bn-card b{color:var(--label)}\n'
        '  .bn-detail{font-family:var(--mono);font-size:11.5px;color:var(--red-d)}',
        'banner and notice styles',
    )

    # 10. Field renames have to reach every reader, not just the writer. The
    #     prototype's helper still asked for `git.integration`, because renaming a
    #     field and updating only the writer leaves every reader broken.
    src = replace_once(
        src,
        "  return SETTINGS.git.integration.replace('{project}',p?p.name:'project');",
        "  return SETTINGS.git.integrationTemplate.replace('{project}',p?p.name:'project');",
        'integrationBranch field rename',
    )

    # 11. Boot instead of rendering fixtures.
    # Anchored on the bare call, not on what follows it: an earlier step may
    # have inserted a function between this and the closing tag.
    src = replace_once(src, '\nrenderAll();\n', '\n' + BOOT_JS + '\n', 'trailing renderAll')

    return src


SETTINGS_JS = """/* Application settings.
 *
 * Loaded from GET /api/settings and saved back with PUT. They are not client-side
 * decoration: the server reads this file before it plans a stage run, so turning
 * a skill off here genuinely stops that stage being automatic. A settings screen
 * that only changes its own appearance would be a lie, and this one is not.
 */
let SETTINGS={
  general:{startup:'portfolio',confirmDestructive:true,showCost:false,telemetry:false},
  agents:{cli:'claude',model:'inherit',maxParallel:4,minParallel:1,maxParallelCap:8,
    isolation:'worktree',copyRoot:'../.worktrees',timeoutMin:30,retries:1,
    pauseOnGate:false,roleModels:{}},
  skills:[],
  mcp:[],
  git:{branchTemplate:'feat/{ticket}',integrationTemplate:'integration/{project}',
    sign:true,draftPr:true,cleanup:true},
  automation:{afk:false,autoMerge:false,maxWaitHours:24,dailySummary:false}
};
/* Read from GET /api/chain: what the machine actually has, rather than what the
   settings claim. A skill named in settings but absent from disk is the failure
   worth showing. */
let CHAIN={skillsRoot:'',chain:[]};
let SETTINGS_SOURCE=null;
let SETTINGS_WARNINGS=[];
"""

REAL_SETTINGS_FUNCS = [
    (
        'function setSkills(){',
        'function setSkills(){\n  if(!CHAIN.chain.length){\n    return sec(t(\'set.cat.skills\'),t(\'set.skills.body\'),\n      \'<div class="empty">\'+t(\'conn.loading\')+\'</div>\');\n  }\n  const enabled=CHAIN.chain.filter(c=>c.enabled&&c.skill).length;\n  const withSkill=CHAIN.chain.filter(c=>c.skill).length;\n  const rows=CHAIN.chain.map(c=>{\n    const nm=c.skill||t(\'set.skills.none\');\n    const missing=c.present===false;\n    return \'<tr><td class="n">\'+nm+\n      (c.skill?\'\':\' <span class="pill p-gray">\'+t(\'set.skills.noSkill\')+\'</span>\')+\n      (missing?\' <span class="pill p-red">\'+t(\'set.skills.missing\')+\'</span>\':\'\')+\'</td>\'+\n      \'<td>\'+stageLabel(c.stage)+\'</td>\'+\n      \'<td class="mono">\'+(c.path||\'—\')+\'</td>\'+\n      \'<td><button class="sw2\'+(c.enabled?\' on\':\'\')+\'" data-skill="\'+c.stage+\'"\'+\n        (c.skill?\'\':\' disabled\')+\'></button></td></tr>\';\n  }).join(\'\');\n  const warn=SETTINGS_WARNINGS.length\n    ? \'<div class="wz-warn">\'+svg(ICON.bolt)+\'<span>\'+SETTINGS_WARNINGS.join(\' · \')+\'</span></div>\'\n    : \'\';\n  return sec(t(\'set.cat.skills\'),t(\'set.skills.body\'),\n      warn+\n      \'<table class="st"><thead><tr>\'+\n      \'<th>\'+t(\'set.skills.col.skill\')+\'</th><th>\'+t(\'set.skills.col.stage\')+\'</th>\'+\n      \'<th>\'+t(\'set.skills.col.path\')+\'</th><th>\'+t(\'set.skills.col.state\')+\'</th>\'+\n      \'</tr></thead><tbody>\'+rows+\'</tbody></table>\'+\n      \'<div class="set-hint">\'+t(\'set.skills.onN\',{n:enabled,total:withSkill})+\' · \'+\n      t(\'set.skills.offNote\')+\' \'+t(\'set.skills.manualNote\')+\n      \'<br><span class="mono">\'+CHAIN.skillsRoot+\'</span></div>\');\n}\n',
    ),
    (
        'function setMcp(){',
        'function setMcp(){\n  const rows=SETTINGS.mcp.map((s,i)=>{\n    const st=s.enabled?(s.reachable===false?\'p-red\':\'p-green\'):\'p-gray\';\n    const stLbl=s.enabled\n      ?(s.reachable===false?t(\'set.mcp.error\'):t(\'set.mcp.connected\'))\n      :t(\'set.mcp.off\');\n    return \'<tr><td class="n">\'+s.name+\n      \'<div class="mono" style="color:var(--label-3);font-weight:400">\'+\n      (s.target||\'\').slice(0,46)+\'</div></td>\'+\n      \'<td><span class="pill p-gray">\'+s.transport+\'</span></td>\'+\n      \'<td style="font-size:11.5px">\'+(s.scope.length?s.scope.map(stageLabel).join(\' · \'):t(\'set.mcp.noScope\'))+\n        (s.env&&s.env.length?\'<div style="color:var(--label-3);margin-top:3px">\'+\n          t(\'set.mcp.env\',{n:s.env.length})+\'</div>\':\'\')+\'</td>\'+\n      \'<td><span class="pill \'+st+\'">\'+stLbl+\'</span></td>\'+\n      \'<td style="white-space:nowrap"><button class="mini-btn" data-mcptest="\'+i+\'">\'+\n        t(\'set.mcp.test\')+\'</button> \'+\n        \'<button class="mini-btn danger" data-mcpdel="\'+i+\'">\'+t(\'set.mcp.remove\')+\'</button></td></tr>\';\n  }).join(\'\');\n  const body=SETTINGS.mcp.length\n    ? \'<table class="st"><thead><tr>\'+\n      \'<th>\'+t(\'set.mcp.col.server\')+\'</th><th>\'+t(\'set.mcp.col.transport\')+\'</th>\'+\n      \'<th>\'+t(\'set.mcp.col.scope\')+\'</th><th>\'+t(\'set.mcp.col.state\')+\'</th><th></th>\'+\n      \'</tr></thead><tbody>\'+rows+\'</tbody></table>\'\n    : \'<div class="empty">\'+t(\'set.mcp.none\')+\'</div>\';\n  return sec(t(\'set.cat.mcp\'),t(\'set.mcp.body\'),\n      body+\n      \'<div style="margin-top:12px"><button class="mini-btn" id="mcpAdd">+ \'+t(\'set.mcp.add\')+\'</button></div>\'+\n      \'<div class="set-hint">\'+t(\'set.mcp.scopeNote\')+\'</div>\');\n}\n',
    ),
    (
        'function setCred(){',
        'function setCred(){\n  const rows=SETTINGS.mcp.filter(s=>s.env&&s.env.length).map(s=>\n    \'<tr><td class="n">\'+s.name+\'</td>\'+\n    \'<td>\'+s.env.map(e=>\'<span class="keybox">\'+e+\'</span>\').join(\' \')+\'</td>\'+\n    \'<td><span class="pill p-teal">\'+t(\'set.cred.keychain\')+\'</span></td>\'+\n    \'<td style="font-size:11.5px">\'+s.scope.map(stageLabel).join(\' · \')+\'</td></tr>\').join(\'\');\n  const body=rows\n    ? \'<table class="st"><thead><tr>\'+\n      \'<th>\'+t(\'set.cred.col.server\')+\'</th><th>\'+t(\'set.cred.col.var\')+\'</th>\'+\n      \'<th>\'+t(\'set.cred.col.stored\')+\'</th><th>\'+t(\'set.cred.col.usedBy\')+\'</th>\'+\n      \'</tr></thead><tbody>\'+rows+\'</tbody></table>\'\n    : \'<div class="empty">\'+t(\'set.cred.none\')+\'</div>\';\n  return sec(t(\'set.cat.credentials\'),t(\'set.cred.body\'),\n      body+\n      \'<div class="wz-warn" style="margin-top:16px;margin-bottom:0">\'+svg(ICON.gate)+\n      \'<span>\'+t(\'set.cred.warn\')+\'</span></div>\');\n}\n',
    ),
    (
        'function stageLabel(id){',
        'function stageLabel(id){\n  const m=(API.STAGE_LABEL||{})[id];\n  return m?L(m):id;\n}\n',
    ),
]

LIVE_HANDLER = """  document.querySelectorAll('#main .gate .gbtns .btn').forEach(b=>b.onclick=()=>{
    // A real gate: record the decision, then re-read the tree. The button decides
    // nothing itself — it writes a line and the server re-derives.
    if(b.dataset.outcome&&b.dataset.ref){
      const ref=b.dataset.ref;
      b.disabled=true;
      (async()=>{
        try{
          await API.decide(ref,{outcome:b.dataset.outcome,evidence:[ref]},'po');
          toast(decodeURIComponent(b.dataset.msg));
          await boot(true);
        }catch(err){
          b.disabled=false;
          toast(String(err&&err.message?err.message:err));
        }
      })();
      return;
    }
    const card=b.closest('.gate');"""

WZ_CREATE = """/**
 * The wizard's last act: write the feature for real.
 *
 * The prototype's version mutated an in-memory object, so the project appeared
 * and then vanished on the next read. This calls the server, which writes the map,
 * the glossary and the spec, and refuses if the feature already exists.
 */
async function wzCreate(){
  const btn=document.getElementById('wzCreateBtn');
  const err=document.getElementById('wzErr');
  const name=WZSTATE.projName.trim()||'camera-watch';
  const feature=wzSlug(name);
  const root=WZSTATE.targetRoot||wzDefaultRoot();
  if(err){err.textContent='';err.style.display='none';}
  if(!root){
    if(err){err.textContent=t('wiz.err.noRoot');err.style.display='block';}
    return;
  }
  if(btn){btn.disabled=true;btn.textContent=t('wiz.creating');}
  try{
    const payload={
      root:root,
      feature:feature,
      title:name,
      destination:L(WIZ.prd.solution)||L(WIZ.prd.problem),
      notes:wzDecisions().map(d=>L(d.q)+' → '+L(d.a)),
      decisions:wzDecisions().map(d=>L(d.q)+': '+L(d.a)),
      notYetSpecified:[L(WIZ.prd.out[0])].filter(Boolean),
      outOfScope:WIZ.prd.out.map(L),
      glossary:WIZ.glossary.map(g=>({word:g.w,meaning:L(g.d)})),
      prd:{
        problem:L(WIZ.prd.problem),
        solution:L(WIZ.prd.solution),
        stories:WIZ.prd.stories.map(L),
        decisions:WIZ.prd.decisions.map(L),
        testing:WIZ.prd.testing.map(L),
        seam:L(WIZ.prd.seam),
        outOfScope:WIZ.prd.out.map(L)
      },
      prototypeTickets:WIZ.protos.map((p,i)=>({
        id:String(i+1),
        title:L(p.t),
        kind:p.kind,
        reason:L(p.why)
      }))
    };
    const result=await API.initFeature(payload);
    closeWizard();
    FEATURE_SEL={};
    STATE.scope='project';
    STATE.project=root.split(/[\\\\/]/).filter(Boolean).pop()||root;
    STATE.view='pipeline';
    STATE.stage=1;
    setSelection(STATE.project,feature);
    await boot(true);
    toast(t('toast.wizCreated',{name:name,path:result.featureDir}));
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent=t('wiz.prd.approve');}
    if(err){err.textContent=String(e&&e.message?e.message:e);err.style.display='block';}
  }
}

/** The rounds, as question and chosen answer, for the map's Decisions section. */
function wzDecisions(){
  const out=[];
  Object.keys(WIZ.q).forEach(id=>{
    const idx=WZSTATE.answers[id];
    if(idx===undefined||idx===null)return;
    const q=WIZ.q[id];
    const a=typeof idx==='string'&&idx.indexOf('other:')===0
      ? {en:idx.slice(6),zh:idx.slice(6)}
      : q.opts[idx]&&q.opts[idx].t;
    if(a)out.push({q:q.t,a:a});
  });
  return out;
}

function wzDefaultRoot(){
  const names=Object.keys(PROJECTS);
  return names.length?PROJECTS[names[0]].root:'';
}

"""

WZ_PRD_TARGET = """  const slug=wzSlug(WZSTATE.projName);
  const roots=Object.keys(PROJECTS).map(k=>PROJECTS[k].root);
  if(!WZSTATE.targetRoot)WZSTATE.targetRoot=roots[0]||'';
  h+='<div class="field"><label>'+t('wiz.prd.project')+'</label>'+
    '<input type="text" id="wzProjName" value="'+WZSTATE.projName+'">'+
    '<div class="hint">'+t('wiz.prd.projectHint',{slug:slug})+'</div></div>';
  h+='<div class="field"><label>'+t('wiz.prd.repo')+'</label>'+
    (roots.length
      ? '<select id="wzRoot">'+roots.map(r=>'<option value="'+r+'"'+
          (r===WZSTATE.targetRoot?' selected':'')+'>'+r+'</option>').join('')+'</select>'
      : '<input type="text" id="wzRoot" placeholder="'+t('wiz.prd.repoPh')+'">')+
    '<div class="hint">'+t('wiz.prd.repoHint')+'</div></div>';
  h+='<div class="field"><div class="wz-warn" id="wzErr" style="display:none;margin-bottom:0"></div></div>';"""

BOOT_JS = """/* ---- bootstrap ---- */

function readSelectionFromHash(){
  const m=/feature=([^&]+)/.exec(location.hash||'');
  return m?{selected:decodeURIComponent(m[1])}:{};
}

function setSelection(project,feature){
  FEATURE_SEL={};
  if(project&&feature)FEATURE_SEL[project]=feature;
  location.hash=project&&feature?('feature='+encodeURIComponent(project)+'/'+encodeURIComponent(feature)):'';
}

function selectionMap(){
  const out={};
  Object.keys(FEATURE_SEL).forEach(k=>{out[k]=FEATURE_SEL[k];});
  return out;
}

/** Load projects, settings and the chain in one pass. */
async function boot(silent){
  const problems=[];
  let projects=[];
  try{
    projects=await API.fetchProjects();
    LOADED=true;
    LOAD_ERROR=null;
  }catch(err){
    LOAD_ERROR=String(err&&err.message?err.message:err);
    LOADED=false;
  }

  try{
    const s=await API.fetchSettings();
    SETTINGS=Object.assign({},SETTINGS,s.settings||{});
    // The server clamps and validates; surface what it changed rather than
    // letting the form disagree with the file.
    SETTINGS_WARNINGS=s.warnings||[];
    SETTINGS_SOURCE=s.source||null;
  }catch(err){
    problems.push('settings: '+(err&&err.message?err.message:err));
  }

  try{
    CHAIN=await API.fetchChain();
  }catch(err){
    problems.push('chain: '+(err&&err.message?err.message:err));
  }

  // The chain has to reach the adapter, or the rail cannot say which skill runs
  // at each stage — and whether that skill is on.
  PROJECTS=API.toProjectsVM(projects,selectionMap(),CHAIN.chain);

  if(STATE.scope==='project'&&!PROJECTS[STATE.project]){
    const first=Object.keys(PROJECTS)[0];
    if(first)STATE.project=first;
    else STATE.scope='portfolio';
  }
  renderAll();
  renderConnection(problems.length?problems.join(' · '):null);
  dismissBootNotice(LOADED?null:(LOAD_ERROR||'the server did not answer'));
  if(!silent&&LOAD_ERROR)toast(LOAD_ERROR);
}

/**
 * Take down the opening notice.
 *
 * It stays up when there is nothing behind it, because a blank page with a clean
 * console is the least diagnosable failure there is. The reason is written into
 * the notice, so it is visible without opening devtools.
 */
function dismissBootNotice(reason){
  const el=document.getElementById('bootNotice');
  if(!el)return;
  if(reason===null||reason===undefined){el.classList.add('gone');return;}
  const d=document.getElementById('bootNoticeDetail');
  if(d)d.textContent=String(reason);
}

function renderConnection(detail){
  const el=document.getElementById('connection');
  if(!el)return;
  const msg=detail||(LOAD_ERROR?t('conn.offline')+': '+LOAD_ERROR:null);
  if(msg){el.textContent=msg;el.className='conn-banner on bad';}
  else{el.textContent='';el.className='conn-banner';}
}

/* The status bar claimed "daemon connected" on the prototype. Nothing is a
   daemon here, so it says what is actually true. */
const _renderStatusbar=renderStatusbar;
renderStatusbar=function(){
  _renderStatusbar();
  const bar=document.getElementById('statusbar');
  if(!bar)return;
  const count=Object.keys(PROJECTS).length;
  bar.innerHTML=LOAD_ERROR
    ?'<span class="pill p-red">'+t('conn.offline')+'</span>'
    :t('status.projects',{n:count})+
      '<span class="sp"></span>'+
      '<span>'+t('conn.localOnly')+'</span>';
};

/* Settings writes go through the server, so the file on disk is the record. */
async function persistSettings(label){
  try{
    const r=await API.saveSettings(SETTINGS);
    SETTINGS=Object.assign({},SETTINGS,r.settings||{});
    SETTINGS_WARNINGS=r.warnings||[];
    renderSettings();
    toast(t('toast.setSaved',{label:label}));
    // The chain may have changed shape; re-read it so a disabled skill shows.
    CHAIN=await API.fetchChain();
  }catch(err){
    toast(String(err&&err.message?err.message:err));
  }
}

const _renderSettings=renderSettings;
renderSettings=function(){
  _renderSettings();
  const m=document.getElementById('setMain');
  if(!m)return;
  // The prototype's handlers wrote to a local object. Delegate instead, so every
  // toggle ends up in the file the runner reads.
  m.querySelectorAll('.sw2[data-t]').forEach(b=>{
    b.onclick=()=>{
      const path=b.dataset.t,parts=path.split('.');
      let o=SETTINGS;
      for(let i=0;i<parts.length-1;i++)o=o[parts[i]];
      if(!o)return;
      o[parts[parts.length-1]]=!o[parts[parts.length-1]];
      renderSettings();
      void persistSettings(labelForSet(parts[parts.length-1]));
    };
  });
  m.querySelectorAll('.sw2[data-skill]').forEach(b=>{
    b.onclick=()=>{
      const stage=b.dataset.skill;
      const s=SETTINGS.skills.find(x=>x.stage===stage);
      if(!s||!s.id)return;
      s.enabled=!s.enabled;
      renderSettings();
      void persistSettings(s.id);
    };
  });
  m.querySelectorAll('[data-wait]').forEach(b=>{
    b.onclick=()=>{
      SETTINGS.automation.maxWaitHours=Math.max(1,Math.min(720,
        SETTINGS.automation.maxWaitHours+ +b.dataset.wait));
      renderSettings();
      void persistSettings(t('set.auto.maxWait',{n:SETTINGS.automation.maxWaitHours}));
    };
  });
  m.querySelectorAll('[data-timeout]').forEach(b=>{
    b.onclick=()=>{
      SETTINGS.agents.timeoutMin=Math.max(1,Math.min(600,
        SETTINGS.agents.timeoutMin+ +b.dataset.timeout));
      renderSettings();
      void persistSettings(t('set.agents.timeout'));
    };
  });
  m.querySelectorAll('[data-retry]').forEach(b=>{
    b.onclick=()=>{
      SETTINGS.agents.retries=Math.max(0,Math.min(10,
        SETTINGS.agents.retries+ +b.dataset.retry));
      renderSettings();
      void persistSettings(t('set.agents.retries'));
    };
  });
  m.querySelectorAll('[data-step]').forEach(b=>{
    b.onclick=()=>{
      SETTINGS.agents.maxParallel=Math.max(1,Math.min(8,
        SETTINGS.agents.maxParallel+ +b.dataset.step));
      renderSettings();
      void persistSettings(t('set.agents.max'));
    };
  });
  m.querySelectorAll('[data-mcptest]').forEach(b=>{
    b.onclick=async()=>{
      const s=SETTINGS.mcp[+b.dataset.mcptest];
      b.disabled=true;
      try{
        const r=await API.testMcp(s.name);
        s.reachable=r.ok;
        toast(t('toast.mcpTested',{name:s.name,result:r.ok?t('set.mcp.connected'):t('set.mcp.error')+' — '+r.detail}));
      }catch(err){
        s.reachable=false;
        toast(String(err&&err.message?err.message:err));
      }
      b.disabled=false;
      renderSettings();
    };
  });
  m.querySelectorAll('[data-mcpdel]').forEach(b=>{
    b.onclick=async()=>{
      const s=SETTINGS.mcp[+b.dataset.mcpdel];
      SETTINGS.mcp=SETTINGS.mcp.filter(x=>x.name!==s.name);
      await persistSettings(s.name);
      toast(t('toast.mcpRemoved',{name:s.name}));
    };
  });
  const add=document.getElementById('mcpAdd');
  if(add)add.onclick=async()=>{
    const n='server-'+(SETTINGS.mcp.length+1);
    SETTINGS.mcp=SETTINGS.mcp.concat([{
      name:n,transport:'stdio',target:'npx -y @scope/server',
      scope:['develop'],enabled:false,env:[]
    }]);
    await persistSettings(n);
    toast(t('toast.mcpAdded',{name:n}));
  };
};

document.getElementById('setToggle').onclick=()=>openSettings();

document.addEventListener('keydown',(e)=>{
  if((e.metaKey||e.ctrlKey)&&e.key==='r'){e.preventDefault();void boot();}
});

void boot();
"""

SETTINGS_VIEW_FUNCS = [
    ('function setGeneral(){', """function setGeneral(){
  const g=SETTINGS.general;
  return sec(t('set.cat.general'),'',
    srow(t('set.general.startup'),'',
      '<select class="gsel" data-t="general.startup" style="font:inherit;font-size:12.5px;padding:5px 9px;border-radius:9px;border:.5px solid var(--sep);background:#fff">'+
      '<option value="portfolio"'+(g.startup==='portfolio'?' selected':'')+'>'+t('set.general.startup.portfolio')+'</option>'+
      '<option value="last"'+(g.startup==='last'?' selected':'')+'>'+t('set.general.startup.last')+'</option>'+
      '</select>')+
    srow(t('set.general.confirm'),'',sw2(g.confirmDestructive,'general.confirmDestructive'))+
    srow(t('set.general.cost'),'',sw2(g.showCost,'general.showCost'))+
    srow(t('set.general.telemetry'),t('set.general.telemetryNote'),sw2(g.telemetry,'general.telemetry'))+
    (SETTINGS_SOURCE
      ? '<div class="set-hint">'+t('set.storedAt')+' <span class="mono">'+SETTINGS_SOURCE+'</span></div>'
      : '')
  );
}
"""),
    ('function setGit(){', """function setGit(){
  const g=SETTINGS.git;
  const name=PROJECTS[STATE.project]?PROJECTS[STATE.project].name:'project';
  return sec(t('set.cat.git'),t('set.git.body'),
      srow(t('set.git.branch'),t('set.git.branchNote'),
        '<span class="keybox">'+g.branchTemplate+'</span>')+
      srow(t('set.git.integration'),'',
        '<span class="keybox">'+g.integrationTemplate.replace('{project}',name)+'</span>')+
      srow(t('set.git.sign'),'',sw2(g.sign,'git.sign'))+
      srow(t('set.git.pr'),'',sw2(g.draftPr,'git.draftPr'))+
      srow(t('set.git.cleanup'),'',sw2(g.cleanup,'git.cleanup'))
    );
}
"""),
    ('function setAuto(){', """function setAuto(){
  const a=SETTINGS.automation;
  return sec(t('set.cat.automation'),t('set.auto.body'),
      srow(t('set.auto.afk'),'',sw2(a.afk,'automation.afk'))+
      srow(t('set.auto.autoMerge'),t('set.auto.autoMergeNote'),sw2(a.autoMerge,'automation.autoMerge'))+
      srow(t('set.auto.maxWait',{n:a.maxWaitHours}),'',
        '<div class="stepper">'+
        '<button data-wait="-12">\u2212</button>'+
        '<span class="val">'+a.maxWaitHours+'h</span>'+
        '<button data-wait="12">+</button></div>')+
      srow(t('set.auto.summary'),'',sw2(a.dailySummary,'automation.dailySummary'))
    );
}
"""),
]

WIZARD_HELPERS_EXTRA = [
    # Header that does not exist yet, so this takes the insert path. Declaring
    # `function flowIdeaView(){` as the header and giving only a prefix as the
    # body was the mistake: it is treated as a complete replacement, so the real
    # function was swapped for an empty shell and every brace after it shifted.
    ('function agentReason(a){', """/**
 * Which reason to attribute to an unusable agent.
 *
 * The server classifies; the interface only has to fall back when an older
 * response carries no reason. Guessing here would put us back where we started.
 */
function agentReason(a){
  if(a&&a.reason)return a.reason;
  // No reason means an older response. Do not guess a category: saying nothing
  // specific is better than saying the wrong specific thing.
  return 'unknown';
}"""),
]


# ---- the concept-init flow ----

WIZARD_FLOW = """function renderWizard(){
  if(!FLOWSTATE.open)return;
  renderFlowTop();renderFlowRail();renderFlowCtx();
  const m=document.getElementById('wzMain');
  const step=FLOW.FLOW_STEPS[FLOWSTATE.step];
  if(step==='idea')m.innerHTML=flowIdeaView();
  else if(step==='rounds')m.innerHTML=flowRoundsView();
  else m.innerHTML=flowPrdView();
  bindFlow(step);
  renderFlowFoot();
  const ex=document.getElementById('wzExit');
  if(ex)ex.textContent=t('wiz.exit');
}"""

WIZARD_HELPERS = [
    ('function openWizard(){', """function openFlow(){
  Object.assign(FLOWSTATE,FLOW.blankFlow(),{open:true});
  const roots=Object.keys(PROJECTS).map(k=>PROJECTS[k].root);
  FLOWSTATE.root=roots[0]||'';
  document.getElementById('wizard').classList.add('on');
  renderFlowTop();renderFlowRail();renderFlowCtx();
  const m=document.getElementById('wzMain');
  m.innerHTML=flowIdeaView();
  bindFlow('idea');
  renderFlowFoot();
  // Find out whether the agent can actually run before the human types anything,
  // so a blocked machine says so up front rather than after a failed turn.
  void probeAgent();
  return FLOWSTATE;
}

/** Keep openWizard as an alias: the menu action and the shortcut use it. */
function openWizard(){return openFlow();}

async function probeAgent(){
  try{
    FLOWSTATE.agent=await API.probeAgent();
  }catch(err){
    FLOWSTATE.agent={available:false,version:null,detail:String(err&&err.message?err.message:err)};
  }
  if(FLOWSTATE.open){renderFlowTop();renderFlowCtx();
    const m=document.getElementById('wzMain');if(m)m.innerHTML=flowIdeaView();bindFlow('idea');renderFlowFoot();}
}"""),
    ('function closeWizard(){', """function closeWizard(){
  FLOWSTATE.open=false;
  document.getElementById('wizard').classList.remove('on');
  document.getElementById('wizard').scrollTop=0;
  renderAll();
}"""),
    ('function wzGo(i){', """function flowGo(i){
  FLOWSTATE.step=Math.max(0,Math.min(FLOW.FLOW_STEPS.length-1,i));
  renderWizard();
  const sc=document.querySelector('.wz-scroll');if(sc)sc.scrollTop=0;
}"""),
    ('function wzTop(){', """function renderFlowTop(){
  document.getElementById('wzEyebrow').textContent=t('wiz.eyebrow');
  document.getElementById('wzStages').textContent=t('wiz.fromSkill');
  const p=FLOW.progress(FLOWSTATE);
  document.getElementById('wzStepN').textContent=L(p.text);
  document.getElementById('wzPct').textContent=p.pct+'%';
  document.getElementById('wzBar').style.width=p.pct+'%';
  const ex=document.getElementById('wzExit');
  if(ex)ex.textContent=t('wiz.exit');
}"""),
    ('function wzRail(){', """function renderFlowRail(){
  document.getElementById('wzRail').innerHTML=
    '<div class="sec" style="padding-top:2px">'+t('wiz.steps')+'</div>'+
    FLOW.FLOW_STEPS.map((s,i)=>{
      const cls=i<FLOWSTATE.step?'done':i===FLOWSTATE.step?'on':'todo';
      return '<div class="wz-step '+cls+'" data-i="'+i+'">'+
        '<span class="wz-n">'+(i<FLOWSTATE.step?'\u2713':i+1)+'</span>'+
        '<div style="min-width:0"><div class="wz-t">'+L(FLOW.STEP_LABEL[s])+'</div>'+
        '<div class="wz-s">'+L(FLOW.STEP_SUB[s])+'</div></div></div>';
    }).join('');
  document.querySelectorAll('#wzRail .wz-step').forEach(e=>
    e.onclick=()=>{
      // Forward only where it is honest to go: you cannot jump to the PRD, and
      // there is nothing to go back to once the rounds have started.
      const i=+e.dataset.i;
      if(i<FLOWSTATE.step)flowGo(i);
    });
}"""),
    ('function wzCtx(){', """function renderFlowCtx(){
  const answers=FLOWSTATE.answers||{};
  const qs=FLOWSTATE.pending?(FLOWSTATE.pending.questions||[]):[];
  let h='';

  // The agent's own state. "Installed" and "can execute" are different facts, and
  // on some machines they differ, so both are shown.
  const a=FLOWSTATE.agent;
  h+='<div class="wz-ctxcard"><h4>'+t('wiz.ctx.agent')+
     '<span>'+(!a?t('conn.loading'):a.available?t('wiz.agent.ok'):t('wiz.agent.blocked'))+'</span></h4>';
  if(!a){
    h+='<div class="task">'+t('conn.loading')+'</div>';
  }else{
    h+='<div class="term"><b class="mono" style="font-size:11px">'+(a.version||'\u2014')+'</b>'+
       '<span style="color:'+(a.available?'var(--label-2)':'var(--red-d)')+'">'+
       (a.available?t('wiz.agent.okDetail'):a.detail)+'</span></div>';
  }
  h+='</div>';

  if(FLOWSTATE.pending){
    h+='<div class="wz-ctxcard"><h4>'+t('wiz.ctx.thisRound')+
       '<span>'+(qs.length?t('wiz.ctx.ofN',{n:qs.filter(q=>answers[q.id]).length,total:qs.length}):'\u2014')+'</span></h4>';
    h+=qs.map(q=>'<div class="term"><b class="mono" style="font-size:11px">'+q.id.toUpperCase()+'</b>'+
      '<span>'+(answers[q.id]?'\u2713':'\u00b7')+' '+q.title+'</span></div>').join('');
    if(qs.length===0)h+='<div class="task">'+t('wiz.ctx.frontierEmpty')+'</div>';
    h+='</div>';
  }

  // What the session has written so far, as reported by the skill.
  const gl=FLOWSTATE.glossary||[],ad=FLOWSTATE.adrs||[];
  if(gl.length||ad.length){
    h+='<div class="wz-ctxcard"><h4>'+t('wiz.ctx.written')+'</h4>';
    if(gl.length)h+=gl.map(g=>'<div class="term"><b>'+g+'</b></div>').join('');
    if(ad.length)h+=ad.map(x=>'<div class="term" style="font-family:var(--mono);font-size:11px"><span>'+x+'</span></div>').join('');
    h+='</div>';
  }

  if(FLOWSTATE.history.length){
    h+='<div class="wz-ctxcard"><h4>'+t('wiz.ctx.rounds')+
       '<span>'+FLOWSTATE.answeredRounds+' '+t('wiz.ctx.answered')+'</span></h4>';
    h+=FLOWSTATE.history.map(r=>'<div class="term"><b class="mono" style="font-size:11px">R'+r.round+'</b>'+
      '<span>'+(r.questions.length?t('wiz.ctx.qN',{n:r.questions.length}):t('wiz.ctx.noQuestions'))+
      (r.frontierEmpty?' \u00b7 '+t('wiz.ctx.empty'):'')+'</span></div>').join('');
    h+='</div>';
  }
  document.getElementById('wzCtx').innerHTML=h;
}"""),
    ('function wzFoot(primary,second){', """function renderFlowFoot(){
  const step=FLOW.FLOW_STEPS[FLOWSTATE.step];
  let h='';
  if(FLOWSTATE.step>0)h+='<button class="btn" id="wzBackBtn">'+t('wiz.back')+'</button>';
  h+='<span class="sp"></span>';

  const why=FLOW.blocker(FLOWSTATE);
  const busy=FLOWSTATE.busy;
  const dis=(!FLOW.canAdvance(FLOWSTATE)||busy)?' disabled':'';

  if(step==='idea'){
    h+='<button class="btn btn-p" id="wzNextBtn"'+dis+'>'+(busy?t('wiz.starting'):t('wiz.start'))+'</button>';
  }else if(step==='rounds'){
    const ready=FLOW.roundComplete(FLOWSTATE,FLOWSTATE.answers||{});
    h+='<button class="btn" id="wzAcceptAll">'+t('wiz.acceptAll')+'</button>';
    if(FLOWSTATE.phase==='ready-for-prd'||FLOWSTATE.phase==='done'){
      h+='<button class="btn btn-p" id="wzPrdBtn">'+(busy?t('wiz.writing'):t('wiz.makePrd'))+'</button>';
    }else{
      h+='<button class="btn btn-p" id="wzAnswerBtn"'+((ready&&!busy)?'':' disabled')+'>'+
         (busy?t('wiz.thinking'):t('wiz.submitRound'))+'</button>';
    }
  }else{
    h+='<button class="btn" id="wzCloseBtn">'+t('wiz.close')+'</button>';
    h+='<button class="btn btn-p" id="wzOpenBtn">'+t('wiz.openProject')+'</button>';
  }

  if(why&&!busy)h='<span style="font-size:11.5px;color:var(--label-3)">'+t('wiz.why.'+why)+'</span>'+h;
  if(FLOWSTATE.error)h='<span style="font-size:11.5px;color:var(--red-d)">'+FLOWSTATE.error+'</span>'+h;
  document.getElementById('wzFoot').innerHTML=h;

  const b=document.getElementById('wzBackBtn');
  if(b)b.onclick=()=>flowGo(FLOWSTATE.step-1);
  const nx=document.getElementById('wzNextBtn');
  if(nx)nx.onclick=flowStart;
  const aa=document.getElementById('wzAcceptAll');
  if(aa)aa.onclick=flowAcceptAll;
  const an=document.getElementById('wzAnswerBtn');
  if(an)an.onclick=flowAnswer;
  const pb=document.getElementById('wzPrdBtn');
  if(pb)pb.onclick=flowMakePrd;
  const cb=document.getElementById('wzCloseBtn');
  if(cb)cb.onclick=closeWizard;
  const ob=document.getElementById('wzOpenBtn');
  if(ob)ob.onclick=flowOpenProject;
}"""),
    ('function wzSeedView(){', """function flowIdeaView(){
  const idea=FLOW.flowIdea(FLOWSTATE);
  const roots=Object.keys(PROJECTS).map(k=>PROJECTS[k].root);
  const a=FLOWSTATE.agent;
  const blocked=a&&a.available===false;

  let h='<h1 class="wz-h1">'+t('flow.idea.title')+'</h1>'+
    '<p class="wz-lede">'+t('flow.idea.lede')+'</p>';

  // In demo mode nothing is wrong: a scripted agent will answer. Reporting the
  // real CLI's credentials here would be both true and misleading.
  if(a&&a.reason==='demo'){
    h+='<div class="wz-warn" style="background:var(--blue-t);color:var(--blue-d)">'+svg(ICON.bolt)+
      '<span><b>'+t('agent.demoOn')+'</b><br>'+t('agent.demoOnHint')+'</span></div>';
  }
  if(blocked){
    // The headline and the advice both come from the reason. A single
    // "cannot run" told people with a perfectly working CLI to go and fix it,
    // when the actual problem was that it was not logged in.
    const why=agentReason(a);
    h+='<div class="wz-warn" style="background:var(--red-t);color:var(--red-d)">'+svg(ICON.gate)+
      '<span><b>'+t('agent.why.'+why)+'</b><br>'+t('agent.hint.'+why)+
      (a.detail?'<br><span class="mono" style="font-size:11px;opacity:.75;word-break:break-all">'+
        esc(a.detail)+'</span>':'')+
      (a.demoAvailable?'<br><span style="opacity:.85">'+t('agent.demoAvailable')+'</span>':'')+
      '</span></div>';
  }

  h+='<div class="field"><label>'+t('wiz.seed.label')+'</label>'+
    '<textarea class="wz-seed" id="flowIdea" placeholder="'+t('wiz.seed.ph')+'">'+idea+'</textarea></div>';

  const suggested=FLOW.slugify(FLOWSTATE.name||FLOW.flowIdea(FLOWSTATE));
  const slug=FLOW.slugify(FLOWSTATE.nameTouched?FLOWSTATE.name:suggested);
  const fullPath=FLOW.featurePath(FLOWSTATE.root,slug);
  h+='<div class="field" style="margin-top:14px"><label>'+t('flow.idea.name')+'</label>'+
    '<input type="text" id="flowName" value="'+(FLOWSTATE.name||suggested)+'">'+
    // The name is a directory inside a real repository. Showing the whole path is
    // what makes that concrete — and what makes a poor name look poor before it
    // is used, rather than after.
    '<div class="hint">'+t('flow.idea.willWrite')+
    '<br><span class="mono" style="font-size:11px;color:var(--label)">'+esc(fullPath)+'</span></div></div>';

  h+='<div class="field" style="margin-top:14px"><label>'+t('wiz.prd.repo')+'</label>'+
    (roots.length
      ? '<select id="flowRoot">'+roots.map(r=>'<option value="'+r+'"'+(r===FLOWSTATE.root?' selected':'')+'>'+r+'</option>').join('')+'</select>'
      : '<input type="text" id="flowRoot" placeholder="'+t('wiz.prd.repoPh')+'">')+
    '<div class="hint">'+t('flow.idea.repoHint')+'</div></div>';

  h+='<div class="wz-warn">'+svg(ICON.bolt)+'<span>'+t('flow.idea.whatHappens')+'</span></div>';
  h+=stuckPanel();
  return h;
}

/**
 * What to do when the name is already taken.
 *
 * Refusing to reuse a name is a guard, not a dead end — but on its own it is one,
 * because there is nothing the human can do about it from here. They started
 * with a name that turned out to be taken (often the demo default), and the only
 * honest offer is to clear it, with the file list shown first.
 */
function stuckPanel(){
  const s=FLOWSTATE.stuck;
  if(!s)return '';
  const dir=FLOW.featurePath(s.root,s.feature);
  let h='<div class="wz-warn" style="background:var(--orange-t);color:var(--orange-d)">'+
    svg(ICON.gate)+'<span><b>'+t('flow.stuck.title')+'</b><br>'+
    '<span class="mono" style="font-size:11px;word-break:break-all">'+esc(dir)+'</span></span></div>';

  if(s.preview){
    // The preview came from the server, so it lists what the removal will
    // actually take — not what this code believes is there.
    h+='<div class="wz-warn" style="background:var(--red-t);color:var(--red-d)">'+
      svg(ICON.gate)+'<span><b>'+t('flow.stuck.confirm',{n:s.preview.files.length})+'</b>'+
      '<div style="margin-top:6px;font-family:var(--mono);font-size:11px;max-height:150px;overflow:auto">'+
      s.preview.files.map(f=>esc(f)).join('<br>')+'</div></span></div>'+
      '<div style="display:flex;gap:9px;margin-bottom:16px">'+
      '<button class="btn" id="wzResetCancel">'+t('flow.stuck.cancel')+'</button>'+
      '<button class="btn" id="wzResetGo" style="background:var(--red-d);border-color:var(--red-d);color:#fff">'+
      t('flow.stuck.remove',{n:s.preview.files.length})+'</button></div>';
  }else{
    h+='<div style="margin-bottom:16px"><button class="btn" id="wzResetStart">'+
      t('flow.stuck.startOver')+'</button></div>';
  }
  return h;
}"""),
    ('function wzFrameView(){', """function flowRoundsView(){
  if(FLOWSTATE.busy&&FLOWSTATE.pending===null){
    return '<h1 class="wz-h1">'+t('flow.rounds.thinking')+'</h1>'+
      '<p class="wz-lede">'+t('flow.rounds.thinkingLede')+'</p>'+
      '<div class="wz-warn">'+svg(ICON.clock)+'<span class="spinner" style="border-top-color:var(--accent)"></span>'+
      '<span>'+t('flow.rounds.thinkingHint')+'</span></div>';
  }
  if(FLOWSTATE.failure!==null){
    return '<h1 class="wz-h1">'+t('flow.rounds.failed')+'</h1>'+
      '<p class="wz-lede">'+t('flow.rounds.failedLede')+'</p>'+
      '<div class="wz-warn" style="background:var(--red-t);color:var(--red-d)">'+svg(ICON.gate)+
      '<span><b>'+t('flow.rounds.why')+'</b><br><span class="mono" style="font-size:11.5px">'+
      FLOWSTATE.failure+'</span></span></div>'+
      '<div class="wz-warn">'+svg(ICON.bolt)+'<span>'+t('flow.rounds.failedHint')+'</span></div>';
  }
  if(FLOWSTATE.phase==='ready-for-prd'||FLOWSTATE.phase==='done'){
    return '<h1 class="wz-h1">'+t('flow.rounds.done')+'</h1>'+
      '<p class="wz-lede">'+t('flow.rounds.doneLede',{n:FLOWSTATE.answeredRounds})+'</p>'+
      '<div class="wz-warn" style="background:var(--green-t);color:var(--green-d)">'+svg(ICON.check)+
      '<span>'+t('flow.rounds.doneHint')+'</span></div>';
  }
  const qs=FLOWSTATE.pending?FLOWSTATE.pending.questions:[];
  if(qs.length===0){
    return '<h1 class="wz-h1">'+t('flow.rounds.none')+'</h1>'+
      '<p class="wz-lede">'+t('flow.rounds.noneLede')+'</p>';
  }
  const answers=FLOWSTATE.answers||{};
  let h='<h1 class="wz-h1">'+t('flow.rounds.title')+'</h1>'+
    '<p class="wz-lede">'+t('flow.rounds.lede')+'</p>'+
    '<div style="display:flex;align-items:center;gap:9px;margin-bottom:16px">'+
    '<span class="pill p-blue">'+t('wiz.rounds.roundN',{n:FLOWSTATE.answeredRounds+1})+'</span>'+
    '<span class="pill p-gray">'+t('wiz.rounds.frontier',{n:qs.length})+'</span>'+
    (FLOWSTATE.pending.source==='markdown'
      ? '<span class="pill p-orange">'+t('flow.rounds.fromProse')+'</span>' : '')+
    '</div>';

  if(FLOWSTATE.pending.glossaryWritten.length){
    h+='<div class="wz-warn" style="background:var(--teal-t);color:var(--teal-d)">'+svg(ICON.check)+
      '<span>'+t('flow.rounds.glossary',{list:FLOWSTATE.pending.glossaryWritten.join(', ')})+'</span></div>';
  }
  if(FLOWSTATE.pending.adrsWritten.length){
    h+='<div class="wz-warn" style="background:var(--purple-t);color:var(--purple-d)">'+svg(ICON.artifact)+
      '<span>'+t('flow.rounds.adrs',{list:FLOWSTATE.pending.adrsWritten.join(', ')})+'</span></div>';
  }

  h+=qs.map((q,n)=>{
    const val=answers[q.id]||'';
    return '<div class="qc" data-q="'+q.id+'">'+
      '<div class="qc-h"><span class="qnum">Q'+(n+1)+'</span><div class="qc-q">'+
      '<div class="qc-t">'+esc(q.title)+'</div>'+
      (q.body?'<div class="qc-b">'+esc(q.body)+'</div>':'')+
      (q.why?'<div class="qc-why">'+svg(ICON.clock)+'<span>'+esc(q.why)+'</span></div>':'')+
      '</div></div>'+
      '<div class="qc-opts">'+
      (q.options||[]).map(o=>{
        const on=val===o;
        const rec=o===q.recommended;
        return '<div class="qo'+(on?' on':'')+'" data-q="'+q.id+'" data-o="'+esc(o)+'">'+
          '<span class="rd"></span><span class="qt">'+esc(o)+
          (rec?'<span class="rec">'+t('wiz.rounds.recommended')+'</span>':'')+'</span></div>';
      }).join('')+
      '</div>'+
      '<div class="qc-other"><input type="text" data-answer="'+q.id+'" value="'+esc(val)+'" placeholder="'+
        (q.recommended?t('wiz.rounds.recommended')+': '+esc(q.recommended):t('wiz.rounds.otherPh'))+'"></div>'+
      (q.recommended?'<div class="qc-foot">'+svg(ICON.check)+'<span>'+esc(q.recommended)+'</span></div>':'')+
      '</div>';
  }).join('');
  return h;
}"""),
    ('function wzDestView(){', """function flowPrdView(){
  if(FLOWSTATE.busy){
    return '<h1 class="wz-h1">'+t('flow.prd.writing')+'</h1>'+
      '<p class="wz-lede">'+t('flow.prd.writingLede')+'</p>'+
      '<div class="wz-warn">'+svg(ICON.clock)+'<span class="spinner" style="border-top-color:var(--accent)"></span>'+
      '<span>'+t('flow.prd.writingHint')+'</span></div>';
  }
  const files=(FLOWSTATE.files||[]);
  let h='<h1 class="wz-h1">'+t('flow.prd.title')+'</h1>'+
    '<p class="wz-lede">'+t('flow.prd.lede',{n:FLOWSTATE.answeredRounds})+'</p>';
  h+='<div class="prd"><h4>'+t('flow.prd.files')+'</h4><div class="pb">'+
    files.map(f=>'<div style="display:flex;gap:9px;margin-bottom:6px">'+
      '<span class="kind k-settled">'+t('flow.prd.written')+'</span>'+
      '<span class="mono" style="font-size:11.5px;word-break:break-all">'+f.path+'</span></div>').join('')+
    '</div></div>';
  if(FLOWSTATE.history.length){
    h+='<div class="prd"><h4>'+t('flow.prd.rounds')+'<span>'+
      FLOWSTATE.history.length+'</span></h4><div class="pb">'+
      FLOWSTATE.history.map(r=>'<div style="margin-bottom:8px">'+
        '<b>'+t('wiz.rounds.roundN',{n:r.round})+'</b> \u2014 '+
        (r.questions.length?esc(r.questions.map(q=>q.title).join('; ')):t('wiz.ctx.noQuestions'))+
        (r.frontierEmpty?' <span class="kind k-settled">'+t('wiz.ctx.empty')+'</span>':'')+
      '</div>').join('')+'</div></div>';
  }
  if(FLOWSTATE.warnings.length){
    h+='<div class="wz-warn">'+svg(ICON.bolt)+'<span>'+FLOWSTATE.warnings.join('<br>')+'</span></div>';
  }
  return h;
}

function esc(s){
  return String(s===undefined||s===null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}"""),
    ('function wzRoundsView(){', """/* ---- the actions ---- */

async function flowStart(){
  const idea=FLOW.flowIdea(FLOWSTATE).trim();
  const name=(FLOWSTATE.name||FLOW.slugify(idea)).trim();
  FLOWSTATE.error=null;FLOWSTATE.idea=idea;FLOWSTATE.ideaTouched=true;
  FLOWSTATE.name=name;
  FLOWSTATE.busy=true;
  FLOWSTATE.step=1;
  renderWizard();
  try{
    const s=await API.startSession(FLOWSTATE.root,FLOW.slugify(name),idea);
    Object.assign(FLOWSTATE,FLOW.absorb(FLOWSTATE,s));
    FLOWSTATE.written={glossary:s.pending?s.pending.glossaryWritten:[],adrs:s.pending?s.pending.adrsWritten:[]};
    FLOWSTATE.glossary=s.pending?s.pending.glossaryWritten:[];
    FLOWSTATE.adrs=s.pending?s.pending.adrsWritten:[];
    FLOWSTATE.answers=s.pending?FLOW.seedAnswers({pending:s.pending}):{};
  }catch(err){
    FLOWSTATE.busy=false;
    const msg=String(err&&err.message?err.message:err);
    // A taken name is recoverable, so it is offered as one. Everything else is
    // shown as a plain error.
    if(FLOW.isNameTaken(msg,FLOW.slugify(name))){
      FLOWSTATE.stuck={root:FLOWSTATE.root,feature:FLOW.slugify(name),message:msg,preview:null};
      FLOWSTATE.error=null;
    }else{
      FLOWSTATE.error=msg;
    }
  }
  renderWizard();
}

/** Ask what would be removed. Deletes nothing — the server does the listing. */
async function flowPreviewReset(){
  if(!FLOWSTATE.stuck)return;
  FLOWSTATE.busy=true;FLOWSTATE.error=null;renderWizard();
  try{
    FLOWSTATE.stuck.preview=await API.resetSession(
      FLOWSTATE.stuck.root,FLOWSTATE.stuck.feature,false);
  }catch(err){
    FLOWSTATE.error=String(err&&err.message?err.message:err);
  }
  FLOWSTATE.busy=false;
  renderWizard();
}

async function flowDoReset(){
  if(!FLOWSTATE.stuck)return;
  const s=FLOWSTATE.stuck;
  FLOWSTATE.busy=true;FLOWSTATE.error=null;renderWizard();
  try{
    await API.resetSession(s.root,s.feature,true);
    FLOWSTATE.stuck=null;
    FLOWSTATE.busy=false;
    toast(t('toast.resetDone',{feature:s.feature}));
    // And then just start, since that is what they were trying to do.
    await flowStart();
    return;
  }catch(err){
    FLOWSTATE.error=String(err&&err.message?err.message:err);
  }
  FLOWSTATE.busy=false;
  renderWizard();
}

function flowAcceptAll(){
  FLOWSTATE.answers=FLOW.seedAnswers(FLOWSTATE);
  renderWizard();
}

async function flowAnswer(){
  const answers=Object.keys(FLOWSTATE.answers||{}).map(k=>({id:k,answer:String(FLOWSTATE.answers[k]||'')}));
  FLOWSTATE.error=null;FLOWSTATE.busy=true;
  renderWizard();
  try{
    const s=await API.answerSession(FLOWSTATE.root,FLOW.slugify(FLOWSTATE.name),answers);
    Object.assign(FLOWSTATE,FLOW.absorb(FLOWSTATE,s));
    FLOWSTATE.glossary=s.pending?s.pending.glossaryWritten:[];
    FLOWSTATE.adrs=s.pending?s.pending.adrsWritten:[];
    FLOWSTATE.answers=s.pending?FLOW.seedAnswers({pending:s.pending}):{};
  }catch(err){
    FLOWSTATE.busy=false;
    FLOWSTATE.error=String(err&&err.message?err.message:err);
  }
  renderWizard();
}

async function flowMakePrd(){
  FLOWSTATE.error=null;FLOWSTATE.busy=true;
  FLOWSTATE.step=2;
  renderWizard();
  try{
    const s=await API.finaliseSession(FLOWSTATE.root,FLOW.slugify(FLOWSTATE.name));
    Object.assign(FLOWSTATE,FLOW.absorb(FLOWSTATE,s));
    FLOWSTATE.files=FLOW.expectedArtifacts(s);
  }catch(err){
    FLOWSTATE.busy=false;
    FLOWSTATE.step=1;
    FLOWSTATE.error=String(err&&err.message?err.message:err);
  }
  renderWizard();
}

async function flowOpenProject(){
  closeWizard();
  FEATURE_SEL={};
  await boot(true);
  const key=Object.keys(PROJECTS).find(k=>PROJECTS[k].root===FLOWSTATE.root);
  if(key){STATE.scope='project';STATE.project=key;STATE.view='pipeline';}
  renderAll();
}"""),
    ('function bindFlow(step){', """function bindFlow(step){
  const m=document.getElementById('wzMain');
  if(step==='idea'){
    const ta=document.getElementById('flowIdea');
    if(ta)ta.oninput=()=>{
      FLOWSTATE.idea=ta.value;FLOWSTATE.ideaTouched=true;
      const nm=document.getElementById('flowName');
      if(nm&&!FLOWSTATE.nameTouched){nm.value=FLOW.slugify(ta.value);}
      renderFlowFoot();
    };
    const nm=document.getElementById('flowName');
    if(nm)nm.oninput=()=>{FLOWSTATE.name=nm.value;FLOWSTATE.nameTouched=true;};
    const rt=document.getElementById('flowRoot');
    if(rt)rt.onchange=()=>{FLOWSTATE.root=rt.value;FLOWSTATE.stuck=null;renderWizard();};
    const so=document.getElementById('wzResetStart');
    if(so)so.onclick=flowPreviewReset;
    const rb=document.getElementById('wzResetGo');
    if(rb)rb.onclick=flowDoReset;
    const rc=document.getElementById('wzResetCancel');
    if(rc)rc.onclick=()=>{if(FLOWSTATE.stuck)FLOWSTATE.stuck.preview=null;renderWizard();};
  }
  if(step==='rounds'){
    FLOWSTATE.answers=FLOWSTATE.answers||{};
    m.querySelectorAll('.qo[data-q]').forEach(o=>o.onclick=()=>{
      FLOWSTATE.answers[o.dataset.q]=o.dataset.o;
      renderWizard();
    });
    m.querySelectorAll('input[data-answer]').forEach(inp=>{
      inp.oninput=()=>{FLOWSTATE.answers[inp.dataset.answer]=inp.value;renderFlowFoot();};
    });
  }
}"""),
]


# ---- additional translation keys ----

I18N_EXTRA = {
    'en': {
        'stage.intake': 'Concept init',
        'stage.ask': 'Requirements',
        'stage.spec': 'Spec',
        'stage.design': 'Design',
        'stage.split': 'Ticketing',
        'stage.develop': 'Build (AFK)',
        'stage.review': 'Acceptance',
        'stage.ship': 'Release',
        'stage.retro': 'Retro',
        'stageshort.intake': 'Concept init',
        'stageshort.ask': 'Requirements',
        'stageshort.spec': 'Spec',
        'stageshort.design': 'Design',
        'stageshort.split': 'Ticketing',
        'stageshort.develop': 'Build (AFK)',
        'stageshort.review': 'Acceptance',
        'stageshort.ship': 'Release',
        'stageshort.retro': 'Retro',
        'set.storedAt': 'Saved in',
        'agent.reason.demo': 'running the demo agent',
        'agent.demoOn': 'Demo mode: a scripted agent answers',
        'agent.demoOnHint': 'This server was started with --demo. The real CLI is not called and nothing is spent. Anything written says it came from the demo.',
        'flow.idea.willWrite': 'This will be written to:',
        'flow.stuck.title': 'That name is already taken',
        'flow.stuck.startOver': 'Show me what is there, and remove it',
        'flow.stuck.confirm': 'Remove this feature? {n} file(s) will be deleted:',
        'flow.stuck.remove': 'Yes, remove {n} file(s)',
        'flow.stuck.cancel': 'Cancel',

        'agent.why.ok': 'ready',
        'agent.why.not-installed': 'The agent CLI is not installed',
        'agent.why.unrunnable': 'The agent CLI could not be started',
        'agent.why.not-authenticated': 'The agent CLI is installed and working, but not logged in',
        'agent.why.blocked': 'This environment will not let the agent CLI run',
        'agent.why.rate-limited': 'The agent CLI is rate limited right now',
        'agent.why.no-session': 'The agent replied without a session id',
        'agent.why.unknown': 'The agent CLI did not complete a turn',
        'agent.hint.not-installed': 'Install it, or point agents.cli in settings at the right command.',
        'agent.hint.unrunnable': 'It was found but would not start. The error is below.',
        'agent.hint.not-authenticated': 'Run the CLI once by hand — `claude` — and follow its prompt. It is not a fault in this application.',
        'agent.hint.blocked': 'An environment restriction, not a configuration problem. Nothing here can change it.',
        'agent.hint.rate-limited': 'Wait and try again.',
        'agent.hint.no-session': 'A conversation cannot be continued without one, so the flow cannot run.',
        'agent.hint.unknown': 'The error below is the raw one.',
        'agent.demoAvailable': 'This server was started with --demo, so you can still walk the flow.',

        'wiz.fromSkill': 'driven by /grill-with-docs',
        'wiz.exit': 'Leave',
        'wiz.steps': 'Steps',
        'wiz.start': 'Start grilling',
        'wiz.starting': 'Starting\u2026',
        'wiz.thinking': 'Thinking\u2026',
        'wiz.writing': 'Writing\u2026',
        'wiz.submitRound': 'Send answers',
        'wiz.acceptAll': 'Take every recommendation',
        'wiz.makePrd': 'Write the PRD',
        'wiz.close': 'Close',
        'wiz.openProject': 'Open the project',
        'wiz.why.busy': 'The agent is working.',
        'wiz.why.error': 'The last turn failed.',
        'wiz.why.failed': 'The session has stopped.',
        'wiz.why.ideaShort': 'Write at least a sentence.',
        'wiz.why.noRepo': 'Pick a repository.',
        'wiz.why.agentBlocked': 'The agent cannot run.',
        'wiz.why.noRound': 'No round to answer.',

        'wiz.agent.ok': 'ready',
        'wiz.agent.blocked': 'cannot run',
        'wiz.agent.okDetail': 'a turn completed and returned a session id',
        'wiz.ctx.agent': 'Agent',
        'wiz.ctx.thisRound': 'This round',
        'wiz.ctx.ofN': '{n} of {total}',
        'wiz.ctx.written': 'Written so far',
        'wiz.ctx.rounds': 'Rounds',
        'wiz.ctx.answered': 'answered',
        'wiz.ctx.qN': '{n} questions',
        'wiz.ctx.noQuestions': 'no questions',
        'wiz.ctx.empty': 'frontier empty',
        'wiz.ctx.frontierEmpty': 'Nothing left to ask.',

        'flow.idea.title': 'What do you want to build?',
        'flow.idea.lede': 'One line, the way you would say it out loud. Do not tidy it up: the ambiguity is what the grilling is for.',
        'flow.idea.name': 'Feature name',
        'flow.idea.nameHint': 'Written into .scratch/{slug}/',
        'flow.idea.repoHint': 'Only configured workspaces are accepted. Nothing outside .scratch/ is touched.',
        'flow.idea.whatHappens': 'Pressing start reads /grill-with-docs and begins the interview. It writes GLOSSARY.md and any ADRs as terms and decisions crystallise.',
        'flow.idea.agentBlocked': 'The agent CLI cannot run on this machine.',
        'flow.idea.agentBlockedHint': 'Installed is not the same as able to execute. The session will start but every turn will fail; fixing the CLI comes first.',

        'flow.rounds.title': 'The round',
        'flow.rounds.lede': 'Each question carries the answer the agent would give. Take them all, change what you disagree with, or write your own.',
        'flow.rounds.thinking': 'Asking the first round\u2026',
        'flow.rounds.thinkingLede': 'The agent is reading the skill and working out what it needs to know.',
        'flow.rounds.thinkingHint': 'This runs in the foreground and can take a minute.',
        'flow.rounds.failed': 'The session stopped',
        'flow.rounds.failedLede': 'A turn could not run. Nothing has been lost: the feature directory and the conversation so far are on disk.',
        'flow.rounds.why': 'The reason, verbatim',
        'flow.rounds.failedHint': 'Fix the cause and start a new session, or drive the skill by hand in that directory.',
        'flow.rounds.done': 'Nothing left to ask',
        'flow.rounds.doneLede': '{n} rounds in, and the design tree is fully explored.',
        'flow.rounds.doneHint': 'The PRD is next. It is written by the same session, from what was settled, not from a fresh interview.',
        'flow.rounds.none': 'No questions in this round',
        'flow.rounds.noneLede': 'The agent replied without a readable round. Its own words are in the turn log.',
        'flow.rounds.glossary': 'Glossary: {list}',
        'flow.rounds.adrs': 'Recorded: {list}',
        'flow.rounds.fromProse': 'read from prose',

        'flow.prd.title': 'The PRD',
        'flow.prd.lede': 'Produced by the same session, after {n} rounds.',
        'flow.prd.files': 'Files',
        'flow.prd.written': 'written',
        'flow.prd.rounds': 'The conversation',
        'flow.prd.writing': 'Writing the PRD\u2026',
        'flow.prd.writingLede': 'The agent is turning what was settled into a spec.',
        'flow.prd.writingHint': 'This runs in the foreground.',

        'set.skills.col.path': 'On disk',
        'set.skills.noSkill': 'no skill',
        'set.skills.missing': 'missing',
        'set.mcp.noScope': 'no stage',
        'set.mcp.none': 'No MCP servers configured. Add one to give agents tools beyond the filesystem.',
        'set.mcp.scopeNote': 'A scope is what keeps one server\u2019s credentials away from an agent working on something else.',
        'set.cred.col.server': 'Server',
        'set.cred.col.var': 'Environment variables',
        'set.cred.none': 'No server needs a key yet. Add an MCP server that declares one.',
        'wiz.prd.repo': 'Into which repository',
        'wiz.prd.repoHint': 'The feature is written to .scratch/ inside this repository. Only configured workspaces are accepted.',
        'wiz.prd.repoPh': 'absolute path to a repository',
        'wiz.err.noRoot': 'No target repository. Add one to governance.workspaces.json first.',
        'wiz.creating': 'Writing\u2026',
    },
    'zh': {
        'stage.intake': '概念初始化',
        'stage.ask': '需求澄清',
        'stage.spec': '规格',
        'stage.design': '架构设计',
        'stage.split': '拆片',
        'stage.develop': '建造（AFK）',
        'stage.review': '验收',
        'stage.ship': '发布',
        'stage.retro': '复盘',
        'stageshort.intake': '概念初始化',
        'stageshort.ask': '需求澄清',
        'stageshort.spec': '规格',
        'stageshort.design': '架构设计',
        'stageshort.split': '拆片',
        'stageshort.develop': '建造（AFK）',
        'stageshort.review': '验收',
        'stageshort.ship': '发布',
        'stageshort.retro': '复盘',
        'set.storedAt': '保存于',
        'agent.reason.demo': '正在使用 demo agent',
        'agent.demoOn': 'Demo 模式：由脚本化 agent 作答',
        'agent.demoOnHint': '这个服务以 --demo 启动。不会调用真实 CLI，也不会产生任何费用。它写出的东西都会标明来自 demo。',
        'flow.idea.willWrite': '会写入到这里：',
        'flow.stuck.title': '这个名字已经被占用了',
        'flow.stuck.startOver': '先看看里面有什么，再决定是否删除',
        'flow.stuck.confirm': '删除这个 feature？将删除 {n} 个文件：',
        'flow.stuck.remove': '确认删除这 {n} 个文件',
        'flow.stuck.cancel': '取消',

        'agent.why.ok': '就绪',
        'agent.why.not-installed': 'agent 命令行没有安装',
        'agent.why.unrunnable': 'agent 命令行无法启动',
        'agent.why.not-authenticated': 'agent 命令行装好了、也能跑，只是没有登录',
        'agent.why.blocked': '当前环境不允许 agent 命令行运行',
        'agent.why.rate-limited': 'agent 命令行当前被限流',
        'agent.why.no-session': 'agent 的回复里没有 session id',
        'agent.why.unknown': 'agent 命令行没有完成一轮',
        'agent.hint.not-installed': '装上它，或者在设置里把 agents.cli 指到正确的命令。',
        'agent.hint.unrunnable': '找到了，但起不来。错误在下面。',
        'agent.hint.not-authenticated': '手工跑一次 CLI —— `claude` —— 按它的提示登录。这不是本应用的问题。',
        'agent.hint.blocked': '这是环境限制，不是配置问题。本应用改不了它。',
        'agent.hint.rate-limited': '等一会儿再试。',
        'agent.hint.no-session': '没有它就无法续接对话，所以流程跑不起来。',
        'agent.hint.unknown': '下面就是原始错误。',
        'agent.demoAvailable': '这个服务是以 --demo 启动的，所以你仍然可以把流程走完。',

        'wiz.fromSkill': '由 /grill-with-docs 驱动',
        'wiz.exit': '离开',
        'wiz.steps': '步骤',
        'wiz.start': '开始追问',
        'wiz.starting': '正在启动…',
        'wiz.thinking': '思考中…',
        'wiz.writing': '正在撰写…',
        'wiz.submitRound': '提交本轮',
        'wiz.acceptAll': '全部接受推荐',
        'wiz.makePrd': '生成 PRD',
        'wiz.close': '关闭',
        'wiz.openProject': '打开项目',
        'wiz.why.busy': 'agent 正在工作。',
        'wiz.why.error': '上一轮失败了。',
        'wiz.why.failed': '会话已停止。',
        'wiz.why.ideaShort': '至少写一句话。',
        'wiz.why.noRepo': '先选一个仓库。',
        'wiz.why.agentBlocked': 'agent 无法运行。',
        'wiz.why.noRound': '没有待答的轮次。',

        'wiz.agent.ok': '就绪',
        'wiz.agent.blocked': '无法运行',
        'wiz.agent.okDetail': '已完成一轮并返回了 session id',
        'wiz.ctx.agent': 'Agent',
        'wiz.ctx.thisRound': '本轮',
        'wiz.ctx.ofN': '{n} / {total}',
        'wiz.ctx.written': '已写入',
        'wiz.ctx.rounds': '轮次',
        'wiz.ctx.answered': '已答',
        'wiz.ctx.qN': '{n} 个问题',
        'wiz.ctx.noQuestions': '无问题',
        'wiz.ctx.empty': '前沿已空',
        'wiz.ctx.frontierEmpty': '没有要问的了。',

        'flow.idea.title': '你想做什么？',
        'flow.idea.lede': '一句话，像平时说话那样写。不用整理 —— 模糊正是追问要处理的东西。',
        'flow.idea.name': 'Feature 名称',
        'flow.idea.nameHint': '会写入 .scratch/{slug}/',
        'flow.idea.repoHint': '只接受已配置的工作区，且不会碰 .scratch/ 之外的任何东西。',
        'flow.idea.whatHappens': '点开始会读取 /grill-with-docs 并启动追问。术语和决策一确定，它就会写进 GLOSSARY.md 和 ADR。',
        'flow.idea.agentBlocked': 'agent 命令行在这台机器上无法运行。',
        'flow.idea.agentBlockedHint': '「装了」和「能跑」是两回事。会话仍会启动，但每一轮都会失败；先修 CLI。',

        'flow.rounds.title': '本轮问题',
        'flow.rounds.lede': '每个问题都带着 agent 自己会给的答案。全部采纳、改掉不同意的，或者自己写。',
        'flow.rounds.thinking': '正在问第一轮…',
        'flow.rounds.thinkingLede': 'agent 正在读 skill，并判断它需要知道什么。',
        'flow.rounds.thinkingHint': '这是前台运行，可能要等一分钟。',
        'flow.rounds.failed': '会话已停止',
        'flow.rounds.failedLede': '有一轮跑不起来。没有任何东西丢失：feature 目录和至今的对话都在磁盘上。',
        'flow.rounds.why': '原因，原文照录',
        'flow.rounds.failedHint': '修好原因后新建一次会话，或者直接在那个目录里手工驱动 skill。',
        'flow.rounds.done': '没有要问的了',
        'flow.rounds.doneLede': '已经问了 {n} 轮，设计树被完整走过了。',
        'flow.rounds.doneHint': '接下来是 PRD。它由同一次会话写成，依据是已经定下的东西，不是重新采访一遍。',
        'flow.rounds.none': '本轮没有问题',
        'flow.rounds.noneLede': 'agent 的回复里没有可读的轮次。它自己的原话在轮次日志里。',
        'flow.rounds.glossary': '术语表：{list}',
        'flow.rounds.adrs': '已记录：{list}',
        'flow.rounds.fromProse': '从散文读取',

        'flow.prd.title': 'PRD',
        'flow.prd.lede': '由同一次会话产出，共 {n} 轮之后。',
        'flow.prd.files': '文件',
        'flow.prd.written': '已写入',
        'flow.prd.rounds': '对话',
        'flow.prd.writing': '正在写 PRD…',
        'flow.prd.writingLede': 'agent 正在把定下来的东西整理成规格。',
        'flow.prd.writingHint': '这是前台运行。',

        'set.skills.col.path': '磁盘位置',
        'set.skills.noSkill': '无 skill',
        'set.skills.missing': '缺失',
        'set.mcp.noScope': '无阶段',
        'set.mcp.none': '还没有配置 MCP 服务。添加一个，agent 就能拿到文件系统之外的工具。',
        'set.mcp.scopeNote': '服务的作用域，正是让某个服务的凭据不会流到在做别的事情的 agent 那里的东西。',
        'set.cred.col.server': '服务',
        'set.cred.col.var': '环境变量',
        'set.cred.none': '还没有服务需要密钥。添加一个声明了密钥的 MCP 服务即可。',
        'wiz.prd.repo': '写入哪个仓库',
        'wiz.prd.repoHint': 'feature 会被写进这个仓库的 .scratch/ 下。只接受已配置的工作区。',
        'wiz.prd.repoPh': '仓库的绝对路径',
        'wiz.err.noRoot': '没有目标仓库。请先在 governance.workspaces.json 里添加一个。',
        'wiz.creating': '正在写入…',
    },
}

I18N_ANCHOR = {
    'en': "      'set.skills.col.state': 'State',\n",
    'zh': "      'set.skills.col.state': '状态',\n",
}

# The toast now reports where the feature landed rather than a stage number.
I18N_REPLACE = [
    ("'toast.wizCreated': 'Project {name} created at Stage {n}',",
     "'toast.wizCreated': 'Wrote {name} to {path}',"),
    ("'toast.wizCreated': '项目 {name} 已创建，落在阶段 {n}',",
     "'toast.wizCreated': '{name} 已写入 {path}',"),
    ("'toast.handled': 'Handled',",
     "'toast.handled': 'Handled', 'toast.resetDone': 'Removed {feature}',"),
    ("'toast.handled': '已处理',",
     "'toast.handled': '已处理', 'toast.resetDone': '已删除 {feature}',"),
]

def i18n_already_patched(text: str) -> bool:
    """Has this file already had the extra keys added?"""
    return "'wiz.err.noRoot'" in text


def patch_i18n(page: str) -> str:
    """Add the keys this wiring introduces, inside the page rather than in a
    separate file: web/i18n.js is a verbatim copy of the prototype's, and keeping
    it that way means the prototype and the app cannot drift."""
    for loc, anchor in I18N_ANCHOR.items():
        if anchor not in page:
            raise SystemExit(f'i18n anchor missing for {loc}')
        lines = ''.join(
            f"      {k!r}: {v!r},\n" for k, v in I18N_EXTRA[loc].items()
        )
        page = page.replace(anchor, anchor + lines, 1)
    for old, new in I18N_REPLACE:
        if old in page:
            page = page.replace(old, new, 1)
    return page


def main() -> int:
    with io.open(PAGE, encoding='utf-8') as f:
        src = f.read()
    out = patch(src)
    with io.open(PAGE, 'w', encoding='utf-8') as f:
        f.write(out)
    print(f'wired {PAGE} ({len(src)} -> {len(out)} bytes)')

    # The dictionary lives in a separate file, loaded over the network, so it is
    # patched separately. It is a verbatim copy of the prototype's, and keeping
    # that true means the prototype and the app cannot drift apart.
    with io.open(I18N, encoding='utf-8') as f:
        i18n = f.read()
    if not i18n_already_patched(i18n):
        patched = patch_i18n(i18n)
        with io.open(I18N, 'w', encoding='utf-8') as f:
            f.write(patched)
        print(f'wired {I18N} ({len(i18n)} -> {len(patched)} bytes)')
    else:
        print(f'{I18N} already carries the extra keys')
    return 0


if __name__ == '__main__':
    sys.exit(main())
