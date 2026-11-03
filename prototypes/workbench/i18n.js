/* Governance i18n core — framework-agnostic, zero DOM dependency.
 *
 * Reusable in three targets without modification:
 *   - browser      : <script src="i18n.js"></script>  -> window.GovernanceI18n
 *   - Electron     : require('./i18n.js')             -> module.exports
 *   - React Native : import I18N from './i18n.js'     (after bundling)
 *
 * Two mechanisms, deliberately:
 *   1. t(key, params)   UI chrome. Keys + flat dictionaries.
 *   2. pick(value)      Content. Inline bilingual fields, e.g. { en: '...', zh: '...' }.
 *                       Keeps domain content out of the key dictionary.
 *
 * Storage is injectable so React Native can pass AsyncStorage instead of
 * localStorage. See configure().
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.GovernanceI18n = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STORAGE_KEY = 'governance.locale';
  var FALLBACK = 'en';

  var META = [
    { code: 'en', label: 'English', short: 'EN', intl: 'en-AU' },
    { code: 'zh', label: '中文', short: '中', intl: 'zh-CN' }
  ];

  var DICT = {
    en: {
      'app.name': 'Governance',

      'menu.file': 'File', 'menu.edit': 'Edit', 'menu.view': 'View',
      'menu.run': 'Run', 'menu.gates': 'Gates', 'menu.help': 'Help',

      'file.new': 'New project…', 'file.open': 'Open workspace…',
      'file.import': 'Import existing repo…', 'file.rescan': 'Rescan .scratch/ and tracker',
      'file.settings': 'Project settings…', 'file.close': 'Close project',
      'file.goto': 'Go to project', 'file.allProjects': 'All projects (overview)',
      'file.blockedSuffix': ' ({n} blocked)',

      'edit.undo': 'Undo', 'edit.redo': 'Redo',
      'edit.copyDossier': 'Copy stage dossier', 'edit.exportAudit': 'Export audit table…',
      'edit.approveAll': 'Approve all in inbox',

      'view.portfolio': 'Portfolio overview', 'view.roadmap': 'Stage roadmap',
      'view.activity': 'Cross-project activity', 'view.pipeline': 'Pipeline and dossiers',
      'view.board': 'Slice board', 'view.inbox': 'Inbox', 'view.releases': 'Releases and servers',
      'view.records': 'All records', 'view.sidebar': 'Show sidebar', 'view.inspector': 'Show inspector',
      'view.language': 'Language',

      'run.advance': 'Advance current stage', 'run.rerun': 'Rerun current stage',
      'run.afk': 'AFK mode (interrupt me only at blockers)', 'run.pauseAll': 'Pause all agents',
      'run.insertGate': 'Insert acceptance gate…',

      'gates.defaults': 'Gate defaults…', 'gates.presets': 'Acceptance method presets',
      'gates.strict': 'Strict · all methods', 'gates.standard': 'Standard · cross-check + sign-off',
      'gates.loose': 'Loose · automated checks only', 'gates.roles': 'Role assignment…',

      'help.flow': 'Workflow map (skill chain)', 'help.skills': 'Skill reference',
      'help.about': 'About Governance',

      'extras.agents': '{n} agents', 'extras.noAgents': 'no agents',
      'extras.ciOk': 'CI green', 'extras.ciBad': 'CI red', 'extras.pending': '{n} pending',

      'toolbar.search': 'Search projects, slices, records',
      'toolbar.collapseSidebar': 'Collapse / expand sidebar',
      'toolbar.collapseInspector': 'Collapse / expand inspector',
      'toolbar.switchProject': 'Switch project',

      'crumb.all': 'All projects', 'crumb.projects': '{n} projects',
      'crumb.agents': '{n} agents running', 'crumb.blocked': '{n} blockers pending',
      'crumb.back': 'Back to all projects', 'crumb.mode': '{mode} · stage {n}/{total} · {name}',

      'sw.all': 'All projects', 'sw.summary': '{n} · {blocked} blocked',

      'sb.projects': 'Projects', 'sb.all': 'All projects', 'sb.portfolio': 'Portfolio overview',
      'sb.current': 'Current project',
      'sb.summaryPortfolio': 'Projects {p} · agents {run} · blockers {blocked}',
      'sb.summaryPortfolio2': '{active} in flight · {done} complete',
      'sb.stage': 'Stage {n} / {total} · {name}',
      'sb.agentsRunning': '{n} agents running in parallel', 'sb.noAgents': 'No agents running',
      'sb.insertGate': 'Insert acceptance gate',
      'sb.owner': 'Owner', 'sb.team': 'Team', 'sb.updated': 'Updated',

      'seg.overview': 'Overview', 'seg.roadmap': 'Roadmap', 'seg.activity': 'Activity',
      'seg.pipeline': 'Pipeline', 'seg.board': 'Board', 'seg.inbox': 'Inbox',
      'seg.releases': 'Releases', 'seg.records': 'Records',

      'status.projects': '{n} projects', 'status.agents': '{n} agents running',
      'status.blocked': '{n} blockers pending', 'status.afk': 'AFK mode',
      'status.tokens': 'Token cost today {amount}', 'status.daemon': 'Daemon connected',

      'pf.total': 'Projects', 'pf.totalNote': '{done} complete · {stalled} with pending blockers',
      'pf.totalUnit': '',
      'pf.running': 'Agents running', 'pf.runningNote': 'Building now',
      'pf.runningNoteNone': 'No agents running',
      'pf.blocked': 'Pending blockers', 'pf.blockedNote': 'Needs you to continue',
      'pf.blockedNoteNone': 'No blockers anywhere',
      'pf.ci': 'CI health', 'pf.ciNoteOk': 'All pipelines passing',
      'pf.ciNoteBad': '{n} projects failing latest pipeline',
      'pf.tracking': 'Project tracking', 'pf.clickRow': 'Click a row to open that project',
      'pf.pending': 'Pending blockers', 'pf.pendingScope': 'Aggregated across projects · includes non-blocking',

      'tbl.project': 'Project', 'tbl.progress': 'Stage progress', 'tbl.stage': 'Current stage',
      'tbl.blocked': 'Blocked', 'tbl.agent': 'Agents', 'tbl.ci': 'CI', 'tbl.activity': 'Latest activity',
      'tbl.done': 'Done', 'tbl.commits': 'Commits', 'tbl.updated': 'Updated',
      'tbl.trigger': 'Triggered by', 'tbl.owner': 'Approver', 'tbl.method': 'Acceptance method',
      'tbl.status': 'Status', 'tbl.interval': 'Run window',

      'gate.blocking': 'blocking', 'gate.nonBlocking': 'non-blocking',
      'gate.ownerIs': 'Approver: {name}',
      'gate.byGateOwner': 'Approver: {name}',
      'gate.insertedByModal': 'Inserted via modal (by you)',
      'gate.pass': 'Pass',
      'gate.passMsg': 'Gate passed; the agent continues',

      'tl.title': 'Stage roadmap', 'tl.subtitle': 'Nine SDLC stages · click a row to open that project',
      'tl.done': 'Complete', 'tl.active': 'In progress', 'tl.blocked': 'Blocked', 'tl.todo': 'Not started',
      'tl.gateNote': 'A diamond after a stage name marks a stage with a human acceptance gate',

      'act.title': 'Cross-project activity',
      'act.subtitle': 'Newest first · run logs merged from every project',
      'act.byProject': 'By project',

      'pipe.title': 'Pipeline', 'pipe.dossier': 'Stage dossier', 'pipe.empty': 'This stage has not run yet, so it has no dossier.<br>Once it starts, inputs, actions, artifacts and the verdict land here.',
      'dossier.inputs': 'Inputs (pointers)', 'dossier.actions': 'Action stream (append-only)',
      'dossier.artifacts': 'Artifact delta (pointer + hash)', 'dossier.gates': 'Gates',
      'dossier.verdict': 'Acceptance verdict', 'dossier.by': 'Approver', 'dossier.method': 'Method',
      'dossier.evidence': 'Evidence', 'dossier.at': 'Time', 'dossier.result': 'Verdict',
      'dossier.trigger': 'triggered by {who}',

      'st.status.done': 'Passed', 'st.status.pending': 'Awaiting approval',
      'st.status.running': 'In progress', 'st.status.todo': 'Not started',
      'st.status.rework': 'Needs rework',

      'board.title': 'Vertical slices', 'board.throughFour': 'each cuts four layers',
      'board.layers': 'Database → Service → UI → Tests', 'board.layerN': 'Layer {n}',
      'board.done': 'Complete', 'board.active': 'In progress', 'board.frontier': 'Frontier · startable',
      'board.blocked': 'Blocked',
      'board.empty': 'No slices yet.<br>Run /to-spec and /to-tickets and the board appears here.<br><br>Remember: a slice must be vertical — it cuts through database, service, UI and tests.',

      'inbox.title': 'Pending for you', 'inbox.scope': 'Aggregated across projects',
      'inbox.empty': 'No pending blockers in any project. Safe to walk away.',

      'rel.pipeline': 'Pipeline', 'rel.servers': 'Servers', 'rel.releases': 'Release history',
      'rel.noRuns': 'no runs yet',
      'rel.events': 'Recent events',

      'rec.title': 'Run records', 'rec.auditTitle': 'Audit rules',
      'rec.auditBody': 'Records are append-only. Every pass must carry a verdict stating who approved it, by which method, against which evidence. A forced override needs a reason and stays in that row forever.',
      'rec.empty': 'No run records for this project yet.',

      'st.phase': 'Stage',

      'ins.gate': 'Gate configuration', 'ins.insert': 'Insert gate', 'ins.global': 'Global settings',
      'ins.portfolioState': 'Portfolio state', 'ins.gateDefaults': 'Gate defaults',
      'ins.defaultMethods': 'Default acceptance methods for new projects',
      'ins.defaultFail': 'Default action when a gate fails', 'ins.blockBehavior': 'Blocking behaviour',
      'ins.blockThen': 'Block downstream stages when a gate fails',
      'ins.saveDefaults': 'Save defaults',
      'ins.roles': 'Role assignment',
      'ins.rolesBody': 'Gates are assigned to roles, not people. Today all roles in all {n} projects rest on you; map members onto roles later and the gates do not change.',
      'ins.manage': 'Manage members',
      'ins.notify': 'Notifications', 'ins.when': 'When to notify me', 'ins.channels': 'Channels',
      'ins.notifyBlocker': 'A blocker appears ({n} now)',
      'ins.notifyStage': 'A stage finishes and awaits approval',
      'ins.notifyCi': 'CI fails', 'ins.notifyCrash': 'An agent crashes or times out',
      'ins.notifyRelease': 'A release is approved or rolled back',
      'ins.chDesktop': 'Desktop notification', 'ins.chEmail': 'Email digest (every 30 min)',
      'ins.chIm': 'Instant message',
      'ins.howRuns': 'How this gate runs',
      'ins.howRunsBody': 'Automated checks run first (CI, types, tests). Then the methods you ticked stack on top: lateral verification spins up a parallel agent that reads only the spec and evidence and never the implementation; cross-check demands two independent pieces of evidence agreeing; adversarial verification sends an agent whose only job is to find counterexamples. Only when all of that passes does the verdict go to {owner} for sign-off.',
      'ins.owner': 'Approver (a role, not a person)', 'ins.methods': 'Acceptance methods',
      'ins.onFail': 'When it fails', 'ins.blockLabel': 'Block downstream stages',
      'ins.save': 'Save', 'ins.rework': 'Send back for rework',
      'ins.scopeLabel': 'Scope', 'ins.triggerLabel': 'Trigger',
      'ins.noGates': 'This project has no gates. You can insert one at any time.',
      'ins.emptyCatalog': 'Gate catalog',

      'modal.title': 'Insert acceptance gate', 'modal.project': 'Which project',
      'modal.where': 'Attach to', 'modal.name': 'Gate name', 'modal.namePh': 'e.g. Throughput approach review',
      'modal.owner': 'Approver (a role, not a person)',
      'modal.ownerHint': 'Today these roles are all you. Map people onto roles later and the gate itself does not change.',
      'modal.methods': 'Acceptance methods (multi-select, they stack)',
      'modal.onFail': 'What happens when it fails', 'modal.block': 'Blocking',
      'modal.blockLabel': 'Block downstream stages (no progress until it passes)',
      'modal.note': 'Note / instruction for the agent',
      'modal.notePh': 'e.g. This slice touches concurrency, so it needs both a load test and a real-path run as evidence.',
      'modal.cancel': 'Cancel', 'modal.create': 'Create and attach',

      'm.auto': 'Automated checks — CI, types, tests',
      'm.self': 'Self-report — producer must attach evidence files',
      'm.lateral': 'Lateral verification — a parallel agent reviews from another angle',
      'm.cross': 'Cross-check — requires two independent pieces of evidence',
      'm.adversarial': 'Adversarial verification — a red-team agent hunts counterexamples',
      'm.signoff': 'Human sign-off — the approver must click pass',
      'm.autoShort': 'Automated checks', 'm.selfShort': 'Self-report',
      'm.lateralShort': 'Lateral verification', 'm.crossShort': 'Cross-check',
      'm.adversarialShort': 'Adversarial verification', 'm.signoffShort': 'Human sign-off',

      'role.po': 'PO (you)', 'role.tech': 'Tech lead', 'role.qa': 'QA / acceptance',
      'role.ops': 'Ops / release', 'role.security': 'Security', 'role.client': 'Client rep',

      'fail.rework': 'Send the slice back and rebuild it to the new design',
      'fail.lower': 'Lower the target and record it in an ADR',
      'fail.accept': 'Accept as-is and record it as a known limitation',
      'fail.escalate': 'Escalate to a human and pause downstream stages',

      'preset.strict': 'Strict preset applied: all methods stacked',
      'preset.standard': 'Standard preset applied: cross-check + sign-off',
      'preset.loose': 'Loose preset applied: automated checks only',

      'about.body': 'Governance Workbench · prototype',
      'about.flow': 'grill-with-docs → prototype/handoff → to-spec → to-tickets → implement(-spec) → code-review → retro',
      'about.skills': 'Skill reference: see ~/.agents/skills/',

      /* ---- concept-init wizard ---- */
      'sb.newProject': 'New project',
      'wiz.eyebrow': 'Concept init',
      'wiz.runsStages': 'Stages 1–3',
      'wiz.exit': 'Back to all projects',
      'wiz.steps': 'Steps',
      'wiz.context': 'Context',
      'wiz.stepN': 'Step {n} of {total}',
      'wiz.itemN': '{n} of {total}',
      'wiz.next': 'Continue', 'wiz.back': 'Back', 'wiz.finish': 'Create project',

      'wiz.step.seed': 'Seed', 'wiz.step.frame': 'Frame', 'wiz.step.destination': 'Destination',
      'wiz.step.rounds': 'Rounds', 'wiz.step.uncertainty': 'Uncertainty', 'wiz.step.prd': 'PRD',
      'wiz.step.seed.s': 'One line', 'wiz.step.frame.s': 'Meaning', 'wiz.step.destination.s': 'Scope',
      'wiz.step.rounds.s': 'Clarify', 'wiz.step.uncertainty.s': 'Prototype', 'wiz.step.prd.s': 'Spec',

      'wiz.seed.title': 'Say what you want in one line — fuzzy is fine',
      'wiz.seed.lede': 'Write it the way you would say it out loud. Do not tidy it up; the ambiguity is the raw material. The next steps exist to strip it out.',
      'wiz.seed.label': 'The idea',
      'wiz.seed.ph': 'e.g. something that watches my camera feed and pings me when something looks off',
      'wiz.seed.examples': 'Try one of these',
      'wiz.seed.repo': 'Existing repo (optional)',
      'wiz.seed.repoPh': 'path, or leave empty for greenfield',
      'wiz.seed.note': 'A one-liner can be read many ways. That is why the next step is to show you the readings rather than assume one.',

      'wiz.frame.title': 'This could mean several different projects',
      'wiz.frame.lede': 'The same sentence hides different structures. Pick the reading that matches your intent — or say none fit. Everything downstream is built on this choice.',
      'wiz.frame.pick': 'Your reading',
      'wiz.frame.other': 'None of these — let me restate it',
      'wiz.frame.otherPh': 'Restate the idea so it points at one thing',
      'wiz.frame.shape': 'What it implies',
      'wiz.frame.recommended': 'Closest fit',
      'wiz.frame.picked': 'Picked reading',

      'wiz.dest.title': 'How far does this go?',
      'wiz.dest.lede': 'The destination fixes the scope. Work beyond it is out of scope, not fog — so naming it early stops the effort drifting.',
      'wiz.dest.kind': 'What should exist at the end',
      'wiz.dest.horizon': 'How much work is this',
      'wiz.dest.budget': 'Time you want to spend before deciding',
      'wiz.dest.hint': 'Changing the destination later means a fresh effort, not a resumed one. Worth a moment now.',

      'wiz.rounds.title': 'Clarifying rounds',
      'wiz.rounds.lede': 'Questions come in rounds. Each round asks everything that can be asked right now, given what is already settled. Answering pushes the edge outward.',
      'wiz.rounds.roundN': 'Round {n}',
      'wiz.rounds.frontier': '{n} questions on the frontier',
      'wiz.rounds.recommended': 'Recommended',
      'wiz.rounds.acceptAll': 'Accept all recommendations',
      'wiz.rounds.submit': 'Submit round',
      'wiz.rounds.other': 'Something else',
      'wiz.rounds.otherPh': 'Your own answer',
      'wiz.rounds.why': 'Why now',
      'wiz.rounds.unblocks': 'Settling this unblocks {n} more',
      'wiz.rounds.done': 'Frontier empty — nothing left silently assumed',
      'wiz.rounds.answeredN': '{n} settled',
      'wiz.rounds.factNote': 'Facts are the agent\u2019s job, not yours. Anything it can look up, it looks up.',

      'wiz.uncertainty.title': 'What needs a runnable answer',
      'wiz.uncertainty.lede': 'Some questions cannot be settled by talking. Those get a throwaway prototype — a small, cheap artifact you react to. The rest stay decisions.',
      'wiz.uncertainty.needs': 'Needs a prototype',
      'wiz.uncertainty.decided': 'Settled in conversation',
      'wiz.uncertainty.ticket': 'Prototype ticket',
      'wiz.uncertainty.branch': 'Lives on its own branch, kept as a primary source',
      'wiz.uncertainty.logic': 'Logic prototype',
      'wiz.uncertainty.ui': 'UI prototype',
      'wiz.uncertainty.why': 'Why not on paper',
      'wiz.uncertainty.none': 'No prototypes needed — conversation settled everything.',

      'wiz.prd.title': 'PRD draft',
      'wiz.prd.lede': 'Synthesised from the rounds, not a fresh interview. Review it, then it goes to the tracker as the spec.',
      'wiz.prd.project': 'Project name',
      'wiz.prd.projectHint': 'Will be created as {slug}',
      'wiz.prd.problem': 'Problem statement',
      'wiz.prd.solution': 'Solution',
      'wiz.prd.stories': 'User stories',
      'wiz.prd.decisions': 'Implementation decisions',
      'wiz.prd.testing': 'Testing decisions',
      'wiz.prd.seams': 'Test seams',
      'wiz.prd.out': 'Out of scope',
      'wiz.prd.storiesN': '{n} stories',
      'wiz.prd.seamNote': 'Prefer an existing seam; use the highest one. The ideal number of new seams is zero.',
      'wiz.prd.approve': 'Approve and create project',
      'wiz.prd.edit': 'Send back to rounds',
      'wiz.prd.glossary': 'Glossary terms this produced',
      'wiz.prd.adr': 'Decisions worth recording',

      'wiz.kind.decision': 'Decision · yours',
      'wiz.kind.fact': 'Fact · agent looks it up',
      'wiz.kind.prototype': 'Needs a prototype',
      'wiz.kind.settled': 'Settled',

      'wiz.ctx.glossary': 'Glossary',
      'wiz.ctx.openDecisions': 'Open decisions',
      'wiz.ctx.factTasks': 'Fact-finding',
      'wiz.ctx.adr': 'ADRs recorded',
      'wiz.ctx.terms': '{n} terms',
      'wiz.ctx.open': '{n} open',
      'wiz.ctx.running': '{n} running',
      'wiz.ctx.none': 'none yet',
      'wiz.ctx.word': 'Word',
      'wiz.ctx.investigating': 'Investigating',
      'wiz.ctx.noTasks': 'Nothing to look up right now.',

      'wiz.empty.seed': 'Add your one-liner to begin.',
      'wiz.empty.frame': 'Pick a reading first.',
      'wiz.empty.rounds': 'Rounds start once a reading is picked.',

      'toast.wizSeeded': 'Idea captured — reading it back as several possible projects',
      'toast.wizFramed': 'Reading picked; next round of questions is ready',
      'toast.wizDest': 'Destination set; the frontier is recomputed',
      'toast.wizRound': 'Round answered — {n} new questions unblocked',
      'toast.wizFrontierEmpty': 'Frontier is empty; nothing left silently assumed',
      'toast.wizAcceptAll': 'All recommendations accepted',
      'toast.wizProto': '{n} prototype tickets created on their own branches',
      'toast.wizCreated': 'Project {name} created at Stage {n}',
      'toast.newProject': 'New project wizard opened',

      /* ---- settings ---- */
      'set.title': 'Settings',
      'set.done': 'Done',
      'set.cat.general': 'General',
      'set.cat.agents': 'Agents',
      'set.cat.skills': 'Skills',
      'set.cat.mcp': 'MCP servers',
      'set.cat.credentials': 'Credentials',
      'set.cat.git': 'Git',
      'set.cat.automation': 'Automation',
      'set.scopeNote': 'Applies to every project in this workspace',

      'set.general.startup': 'Open on launch',
      'set.general.startup.portfolio': 'All projects (portfolio)',
      'set.general.startup.last': 'The last project I had open',
      'set.general.confirm': 'Ask before anything destructive (force-approve, rollback, delete)',
      'set.general.cost': 'Show token cost in the status bar',
      'set.general.telemetry': 'Send anonymous usage data',
      'set.general.telemetryNote': 'Off by default. Off means off: nothing leaves this machine.',

      'set.agents.runtime': 'Runtime',
      'set.agents.cli': 'Agent CLI',
      'set.agents.model': 'Default model',
      'set.agents.model.inherit': 'Inherit from the session',
      'set.agents.roleModels': 'Per-role overrides',
      'set.agents.roleModelsNote': 'Leave a role on “inherit” unless you have a reason. Cheaper models are usually fine for review roles and a bad idea for the ones that write code.',

      'set.agents.concurrency': 'Concurrency',
      'set.agents.max': 'Max parallel agents',
      'set.agents.maxHint': 'Every agent gets its own branch and its own working copy, so nothing two agents do can collide. This caps how many run at once.',
      'set.agents.slots': 'Allocation right now',
      'set.agents.worker': 'Worker {n}',
      'set.agents.idle': 'idle',
      'set.agents.free': '{n} slot(s) free',
      'set.agents.full': 'all slots busy',
      'set.agents.mergesInto': 'Merges into',
      'set.agents.frontierN': '{n} slices ready',

      'set.agents.isolation': 'Isolation',
      'set.agents.iso.worktree': 'Git worktree',
      'set.agents.iso.container': 'Container per agent',
      'set.agents.iso.vm': 'VM per agent',
      'set.agents.iso.worktree.d': 'Cheapest by far. Shares the object store; only the working copy is separate. Right answer unless agents run untrusted code.',
      'set.agents.iso.container.d': 'Stronger isolation for untrusted dependencies. Slower to start, and it needs an image.',
      'set.agents.iso.vm.d': 'Full isolation, heaviest by far. Reach for it only when the code itself is untrusted.',

      'set.agents.copyRoot': 'Working copies live in',
      'set.agents.copyRootNote': 'Outside the repository, so an agent cannot commit another agent’s scratch files.',
      'set.agents.timeout': 'Stage timeout',
      'set.agents.timeoutUnit': '{n} min',
      'set.agents.retries': 'Retries before escalating to you',
      'set.agents.pauseOnGate': 'Pause every agent when a gate appears',
      'set.agents.pauseOnGateNote': 'Off means agents keep building while you answer. On means nothing moves until you do.',

      'set.skills.body': 'A skill is one unit of work the orchestrator runs. Turn one off and the stage that used it stops being automatic — it waits for you instead.',
      'set.skills.col.skill': 'Skill',
      'set.skills.col.stage': 'Runs at',
      'set.skills.col.source': 'Source',
      'set.skills.col.state': 'State',
      'set.skills.enabled': 'enabled',
      'set.skills.disabled': 'disabled',
      'set.skills.none': 'no skill',
      'set.skills.onN': '{n} of {total} enabled',
      'set.skills.manualNote': 'Stages with no skill are manual or handled by CI.',
      'set.skills.offNote': 'Disabled skills do not run. The stage becomes a gate you work yourself.',
      'set.skills.pool': 'Also available (not in the chain)',

      'set.mcp.body': 'MCP servers give agents tools beyond the filesystem. Each one is scoped to the stages that need it, so a credential for one server never reaches an agent working on something else.',
      'set.mcp.add': 'Add server',
      'set.mcp.col.server': 'Server',
      'set.mcp.col.transport': 'Transport',
      'set.mcp.col.scope': 'Available to',
      'set.mcp.col.state': 'State',
      'set.mcp.connected': 'connected',
      'set.mcp.error': 'error',
      'set.mcp.off': 'disabled',
      'set.mcp.env': '{n} env var(s)',
      'set.mcp.test': 'Test',
      'set.mcp.remove': 'Remove',
      'set.mcp.scopeAll': 'every stage',
      'set.mcp.errNote': 'This server failed its last handshake. Agents that need it will stop at a gate rather than run without it.',

      'set.cred.body': 'Keys live in the OS keychain — never in the repository, never in a file that could be committed. Agents read them through the keychain at run time.',
      'set.cred.col.provider': 'Provider',
      'set.cred.col.stored': 'Stored in',
      'set.cred.col.usedBy': 'Used by',
      'set.cred.keychain': 'OS keychain',
      'set.cred.ci': 'CI secret',
      'set.cred.add': 'Add key',
      'set.cred.rotate': 'Rotate',
      'set.cred.warn': 'A key pasted into a repository is a key you have to rotate. Preventing that is what the /wizard skill exists for.',

      'set.git.body': 'How work branches out, and how it comes back together.',
      'set.git.branch': 'Branch name for a slice',
      'set.git.branchNote': '{ticket} is replaced with the ticket id, so branch and ticket stay findable from either end.',
      'set.git.integration': 'Integration branch',
      'set.git.sign': 'Sign commits',
      'set.git.pr': 'Open a draft pull request once the integration branch has its first merge',
      'set.git.cleanup': 'Delete an agent’s working copy once its slice merges',

      'set.auto.body': 'What happens while you are not looking.',
      'set.auto.afk': 'Start in AFK mode',
      'set.auto.autoMerge': 'Auto-merge a slice the moment its gate passes',
      'set.auto.autoMergeNote': 'Off means gates queue up for you and nothing merges unattended. That is the safer default.',
      'set.auto.maxWait': 'Escalate to me if a gate waits longer than {n} h',
      'set.auto.summary': 'Send a daily summary at 09:00',

      'set.crumb.thisMachine': 'This machine',
      'set.applies': 'Changes save as you make them',

      'toast.setSaved': '{label} updated',
      'toast.setClamped': 'Max parallel agents must be between {min} and {max}; set to {n}',
      'toast.skillOff': '{name} disabled — that stage is now yours',
      'toast.skillOn': '{name} enabled',
      'toast.mcpAdded': '{name} added; not connected yet',
      'toast.mcpRemoved': '{name} removed from every stage',
      'toast.mcpTested': '{name}: {result}',
      'toast.credRotate': 'Rotation started for {provider}',

      'toast.advance': 'Advanced to the next stage (prototype)',
      'toast.rerun': 'Current stage rerun',
      'toast.afkOn': 'AFK mode on — the agent runs until the next blocker, then pings you',
      'toast.afkOff': 'AFK mode off',
      'toast.approveAll': 'Approved {n} blocking gates in {project}; the agent continues',
      'toast.approveNone': 'No gates to approve in this project',
      'toast.pauseAll': 'All agents paused',
      'toast.rescan': 'Rescanned .scratch/ and the tracker; records refreshed',
      'toast.copyDossier': 'Stage dossier copied as markdown',
      'toast.exportAudit': 'Audit table exported as CSV',
      'toast.newProject': 'New project wizard opened',
      'toast.openWs': 'Workspace picker opened',
      'toast.importRepo': 'Repo import opened',
      'toast.settings': 'Project settings opened',
      'toast.gateDefaults': 'Gate defaults opened',
      'toast.roles': 'Role assignment opened',
      'toast.gateCreated': 'Gate attached to {scope} in {project}, approver {owner}',
      'toast.enteredInbox': 'Opened the {project} inbox',
      'toast.scopePortfolio': 'Switched to all projects',
      'toast.scopeProject': 'Switched to {name}',
      'toast.blocked': 'Gate passed; the agent continues',
      'toast.handled': 'Handled as requested',
      'toast.locale': 'Language switched to {label}'
    },

    zh: {
      'app.name': 'Governance',

      'menu.file': '文件', 'menu.edit': '编辑', 'menu.view': '视图',
      'menu.run': '运行', 'menu.gates': '门控', 'menu.help': '帮助',

      'file.new': '新建项目…', 'file.open': '打开工作区…',
      'file.import': '导入现有仓库…', 'file.rescan': '重新扫描 .scratch/ 与 tracker',
      'file.settings': '项目设置…', 'file.close': '关闭项目',
      'file.goto': '前往项目', 'file.allProjects': '全部项目（总览）',
      'file.blockedSuffix': '（{n} 个阻塞）',

      'edit.undo': '撤销', 'edit.redo': '重做',
      'edit.copyDossier': '拷贝阶段档案', 'edit.exportAudit': '导出审计表…',
      'edit.approveAll': '全部通过收件箱',

      'view.portfolio': '项目总览（全部项目）', 'view.roadmap': '阶段路线图',
      'view.activity': '跨项目动态', 'view.pipeline': '流水线与档案',
      'view.board': '切片看板', 'view.inbox': '收件箱', 'view.releases': '发布与服务器',
      'view.records': '全部记录', 'view.sidebar': '显示侧栏', 'view.inspector': '显示检查器',
      'view.language': '语言',

      'run.advance': '推进当前阶段', 'run.rerun': '重跑当前阶段',
      'run.afk': 'AFK 模式（仅阻塞点叫我）', 'run.pauseAll': '暂停所有 agent',
      'run.insertGate': '插入验收门…',

      'gates.defaults': '门的默认配置…', 'gates.presets': '验收方法预设',
      'gates.strict': '严格 · 全叠加', 'gates.standard': '标准 · 交叉验证 + 人工签署',
      'gates.loose': '宽松 · 仅自动检查', 'gates.roles': '角色分派…',

      'help.flow': '工作流地图（skill 链路）', 'help.skills': 'skill 参考',
      'help.about': '关于 Governance',

      'extras.agents': '{n} 个 agent', 'extras.noAgents': '无 agent',
      'extras.ciOk': 'CI 绿', 'extras.ciBad': 'CI 红', 'extras.pending': '{n} 待处理',

      'toolbar.search': '搜索项目、切片、记录',
      'toolbar.collapseSidebar': '收起 / 展开侧栏',
      'toolbar.collapseInspector': '收起 / 展开检查器',
      'toolbar.switchProject': '切换项目',

      'crumb.all': '全部项目', 'crumb.projects': '{n} 个项目',
      'crumb.agents': '{n} 个 agent 并行', 'crumb.blocked': '{n} 个阻塞待处理',
      'crumb.back': '返回全部项目', 'crumb.mode': '{mode} · 阶段 {n}/{total} · {name}',

      'sw.all': '全部项目', 'sw.summary': '{n} 个 · {blocked} 阻塞',

      'sb.projects': '项目', 'sb.all': '全部项目', 'sb.portfolio': '组合概览',
      'sb.current': '当前项目',
      'sb.summaryPortfolio': '项目 {p} · agent {run} · 阻塞 {blocked}',
      'sb.summaryPortfolio2': '推进中 {active} · 已完成 {done}',
      'sb.stage': '阶段 {n} / {total} · {name}',
      'sb.agentsRunning': '{n} 个 agent 并行运行', 'sb.noAgents': '当前无 agent 运行',
      'sb.insertGate': '插入验收门',
      'sb.owner': '负责人', 'sb.team': '团队', 'sb.updated': '更新',

      'seg.overview': '总览', 'seg.roadmap': '路线图', 'seg.activity': '动态',
      'seg.pipeline': '流水线', 'seg.board': '看板', 'seg.inbox': '收件箱',
      'seg.releases': '发布', 'seg.records': '记录',

      'status.projects': '{n} 个项目', 'status.agents': '{n} 个 agent 并行',
      'status.blocked': '{n} 个阻塞点待处理', 'status.afk': 'AFK 模式',
      'status.tokens': '今日 token 成本 {amount}', 'status.daemon': '守护进程已连接',

      'pf.total': '项目总数', 'pf.totalNote': '{done} 个已跑完 · {stalled} 个有待处理阻塞',
      'pf.totalUnit': '个',
      'pf.running': '并行 agent', 'pf.runningNote': '正在建造中',
      'pf.runningNoteNone': '当前无 agent 运行',
      'pf.blocked': '待处理阻塞', 'pf.blockedNote': '需你介入才能继续',
      'pf.blockedNoteNone': '所有项目均无阻塞',
      'pf.ci': 'CI 健康', 'pf.ciNoteOk': '全部流水线通过',
      'pf.ciNoteBad': '{n} 个项目最新流水线失败',
      'pf.tracking': '项目跟踪', 'pf.clickRow': '点击任一行进入该项目',
      'pf.pending': '待处理阻塞', 'pf.pendingScope': '全部项目聚合 · 含不阻塞项',

      'tbl.project': '项目', 'tbl.progress': '阶段推进', 'tbl.stage': '当前阶段',
      'tbl.blocked': '阻塞', 'tbl.agent': 'Agent', 'tbl.ci': 'CI', 'tbl.activity': '最近活动',
      'tbl.done': '已完成', 'tbl.commits': '提交', 'tbl.updated': '最近更新',
      'tbl.trigger': '触发者', 'tbl.owner': '验收人', 'tbl.method': '验收方法',
      'tbl.status': '状态', 'tbl.interval': '运行区间',

      'gate.blocking': '阻塞', 'gate.nonBlocking': '不阻塞',
      'gate.ownerIs': '验收人：{name}', 'gate.byGateOwner': '验收人：{name}',
      'gate.insertedByModal': 'Modal 插入（你）',
      'gate.pass': '通过',
      'gate.passMsg': '门已通过，agent 继续',

      'tl.title': '阶段路线图', 'tl.subtitle': '九个 SDLC 阶段 · 点击任一行进入该项目',
      'tl.done': '已完成', 'tl.active': '进行中', 'tl.blocked': '被阻塞', 'tl.todo': '未开始',
      'tl.gateNote': '阶段名后的 ◆ 表示该阶段带人工验收门',

      'act.title': '跨项目动态',
      'act.subtitle': '按时间倒序 · 合并全部项目的运行日志',
      'act.byProject': '按项目统计',

      'pipe.title': '流水线', 'pipe.dossier': '阶段档案', 'pipe.empty': '该阶段尚未执行，没有档案。<br>阶段开始后，输入、动作流、产物与验收结论会实时落进这里。',
      'dossier.inputs': '输入（指针）', 'dossier.actions': '动作流（append-only）',
      'dossier.artifacts': '产物增量（指针 + 哈希）', 'dossier.gates': '门',
      'dossier.verdict': '验收结论', 'dossier.by': '验收人', 'dossier.method': '方法',
      'dossier.evidence': '依据', 'dossier.at': '时间', 'dossier.result': '结论',
      'dossier.trigger': '触发：{who}',

      'st.status.done': '已通过', 'st.status.pending': '待批准',
      'st.status.running': '进行中', 'st.status.todo': '未开始',
      'st.status.rework': '需重做',

      'board.title': '垂直切片', 'board.throughFour': '每片穿透四层',
      'board.layers': '数据库 → 服务 → 界面 → 测试', 'board.layerN': '第 {n} 层',
      'board.done': '已完成', 'board.active': '进行中', 'board.frontier': '前沿 · 可开工',
      'board.blocked': '被阻塞',
      'board.empty': '还没有切片。<br>跑完 /to-spec 与 /to-tickets，看板会自动出现。<br><br>记住：切片必须是垂直的 — 每片穿透数据库、服务、界面、测试四层。',

      'inbox.title': '待你处理', 'inbox.scope': '跨项目聚合',
      'inbox.empty': '所有项目都没有待处理的阻塞点。可以放心离开。',

      'rel.pipeline': '流水线', 'rel.servers': '服务器', 'rel.releases': '发布记录',
      'rel.noRuns': '暂无运行',
      'rel.events': '最近事件',

      'rec.title': '运行记录', 'rec.auditTitle': '审计口径',
      'rec.auditBody': '记录只追加、不修改。任何「通过」都必须落一条验收结论，写明谁、用什么方法、依据哪几份证据。强制通过需要填理由，并且会永久留在这一行里。',
      'rec.empty': '该项目暂无运行记录。',

      'st.phase': '阶段',

      'ins.gate': '门配置', 'ins.insert': '插入门', 'ins.global': '全局设置',
      'ins.portfolioState': '组合状态', 'ins.gateDefaults': '门控默认值',
      'ins.defaultMethods': '新项目的默认验收方法',
      'ins.defaultFail': '默认未通过动作', 'ins.blockBehavior': '阻塞行为',
      'ins.blockThen': '阻塞时不推进后续阶段',
      'ins.saveDefaults': '保存默认值',
      'ins.roles': '角色分派',
      'ins.rolesBody': '门挂的是角色，不是人。现在 {n} 个项目的全部角色都由你一个人承担；将来把成员挂到角色上，门本身不用改。',
      'ins.manage': '管理成员',
      'ins.notify': '通知', 'ins.when': '什么时候叫我', 'ins.channels': '渠道',
      'ins.notifyBlocker': '阻塞点出现（当前 {n} 个）',
      'ins.notifyStage': '阶段完成待验收',
      'ins.notifyCi': 'CI 失败', 'ins.notifyCrash': 'agent 崩溃或超时',
      'ins.notifyRelease': '发布被批准 / 回滚',
      'ins.chDesktop': '桌面通知', 'ins.chEmail': '邮件摘要（每 30 分钟）',
      'ins.chIm': '即时消息',
      'ins.howRuns': '这条门会怎么执行',
      'ins.howRunsBody': '先跑自动部分（CI / 类型 / 测试）。然后按你勾选的方法依次叠加：侧向验证会另起一个平行 agent，只读 spec 与证据、不看实现，独立给结论；交叉验证要求至少两条互相独立的证据都指向同一结论；对抗验证会派一个专门找反例的 agent。全部通过后，才把结论交给 {owner} 等待签署。',
      'ins.owner': '验收人（角色）', 'ins.methods': '验收方法',
      'ins.onFail': '未通过时', 'ins.blockLabel': '阻塞后续阶段',
      'ins.save': '保存', 'ins.rework': '退回重做',
      'ins.scopeLabel': '范围', 'ins.triggerLabel': '触发方式',
      'ins.noGates': '该项目当前没有门。你可以随时手动插入一个。',
      'ins.emptyCatalog': '门目录',

      'modal.title': '插入验收门', 'modal.project': '挂到哪个项目',
      'modal.where': '挂在哪里', 'modal.name': '门名', 'modal.namePh': '例如：吞吐方案复核',
      'modal.owner': '验收人（角色，不是人）',
      'modal.ownerHint': '现在这些角色都是你。将来把人分派到角色上，门本身不用改。',
      'modal.methods': '验收方法（可多选，会叠加执行）',
      'modal.onFail': '未通过时做什么', 'modal.block': '阻塞',
      'modal.blockLabel': '阻塞后续阶段（不通过就不往下走）',
      'modal.note': '备注 / 给 agent 的指令',
      'modal.notePh': '例如：这一片涉及并发，必须同时有压测和真实链路两条证据。',
      'modal.cancel': '取消', 'modal.create': '创建并挂上',

      'm.auto': '自动检查 — CI / 类型 / 测试',
      'm.self': '自检报告 — 产出者必须附证据文件',
      'm.lateral': '侧向验证 — 平行 agent 换视角复核',
      'm.cross': '交叉验证 — 要求两条独立证据',
      'm.adversarial': '对抗验证 — 红队 agent 找反例',
      'm.signoff': '人工签署 — 必须由验收人点通过',
      'm.autoShort': '自动检查', 'm.selfShort': '自检报告',
      'm.lateralShort': '侧向验证', 'm.crossShort': '交叉验证',
      'm.adversarialShort': '对抗验证', 'm.signoffShort': '人工签署',

      'role.po': 'PO（你）', 'role.tech': '技术负责人', 'role.qa': 'QA / 验收',
      'role.ops': '运维 / 发布', 'role.security': '安全', 'role.client': '客户代表',

      'fail.rework': '退回该切片，按新设计重做',
      'fail.lower': '下调目标并记入 ADR',
      'fail.accept': '接受现状，记为已知限制',
      'fail.escalate': '升级给人处理，暂停后续阶段',

      'preset.strict': '已应用严格预设：全叠加',
      'preset.standard': '已应用标准预设：交叉验证 + 人工签署',
      'preset.loose': '已应用宽松预设：仅自动检查',

      'about.body': 'Governance Workbench · 原型',
      'about.flow': 'grill-with-docs → prototype/handoff → to-spec → to-tickets → implement(-spec) → code-review → retro',
      'about.skills': 'skill 参考：见 ~/.agents/skills/',

      /* ---- 概念初始化向导 ---- */
      'sb.newProject': '新增项目',
      'wiz.eyebrow': '概念初始化',
      'wiz.runsStages': '阶段 1–3',
      'wiz.exit': '返回全部项目',
      'wiz.steps': '步骤',
      'wiz.context': '上下文',
      'wiz.stepN': '第 {n} 步 / 共 {total} 步',
      'wiz.itemN': '第 {n} 项 / 共 {total} 项',
      'wiz.next': '继续', 'wiz.back': '上一步', 'wiz.finish': '创建项目',

      'wiz.step.seed': '一句话', 'wiz.step.frame': '含义', 'wiz.step.destination': '目标',
      'wiz.step.rounds': '澄清', 'wiz.step.uncertainty': '原型', 'wiz.step.prd': 'PRD',
      'wiz.step.seed.s': '说清想做什么', 'wiz.step.frame.s': '这句话可能是什么意思',
      'wiz.step.destination.s': '做到什么程度', 'wiz.step.rounds.s': '逐轮追问',
      'wiz.step.uncertainty.s': '哪些要跑起来才知道', 'wiz.step.prd.s': '定稿进入规格',

      'wiz.seed.title': '用一句话说清你想做什么 —— 模糊没关系',
      'wiz.seed.lede': '像平时说话那样写下来就行，不用整理。模糊本身就是原材料，后面几步就是为了把它剥干净。',
      'wiz.seed.label': '你的想法',
      'wiz.seed.ph': '例如：做个能盯着我摄像头画面、发现不对劲就通知我的东西',
      'wiz.seed.examples': '或者试试这些',
      'wiz.seed.repo': '已有仓库（可选）',
      'wiz.seed.repoPh': '路径，留空表示全新项目',
      'wiz.seed.note': '一句话可以有很多种读法。所以下一步不是假设一种，而是把几种读法都摆给你看。',

      'wiz.frame.title': '这句话可能是好几个不同的项目',
      'wiz.frame.lede': '同一句话底下藏着不同的结构。选一个符合你意图的读法 —— 或者说不合适。后面所有事都建立在这个选择上。',
      'wiz.frame.pick': '你的读法',
      'wiz.frame.other': '都不对 —— 让我重新说一遍',
      'wiz.frame.otherPh': '重新描述，让它只指向一件事',
      'wiz.frame.shape': '它意味着',
      'wiz.frame.recommended': '最接近',
      'wiz.frame.picked': '已选读法',

      'wiz.dest.title': '这件事要做到什么程度？',
      'wiz.dest.lede': '目标决定范围。目标之外的事属于「范围外」而不是「迷雾」—— 早一点说清，effort 就不会漂。',
      'wiz.dest.kind': '最后要存在的东西',
      'wiz.dest.horizon': '这是多大的工程',
      'wiz.dest.budget': '你愿意先投入多少再决定',
      'wiz.dest.hint': '后面改目标等于另起一次 effort，而不是接着做。现在花一分钟值得。',

      'wiz.rounds.title': '澄清轮次',
      'wiz.rounds.lede': '问题按轮来。每一轮只问「以目前已定的东西为前提、现在就能问」的全部问题。答完一轮，边界往外推一圈。',
      'wiz.rounds.roundN': '第 {n} 轮',
      'wiz.rounds.frontier': '前沿有 {n} 个问题',
      'wiz.rounds.recommended': '推荐',
      'wiz.rounds.acceptAll': '全部接受推荐',
      'wiz.rounds.submit': '提交本轮',
      'wiz.rounds.other': '其它',
      'wiz.rounds.otherPh': '我自己的答案',
      'wiz.rounds.why': '为什么现在问',
      'wiz.rounds.unblocks': '定了它会解锁另外 {n} 个问题',
      'wiz.rounds.done': '前沿已空 —— 没有任何东西被默默假设',
      'wiz.rounds.answeredN': '已定 {n} 项',
      'wiz.rounds.factNote': '事实是 agent 的活，不是你的。凡是它能查到的，它自己查。',

      'wiz.uncertainty.title': '哪些必须跑起来才知道',
      'wiz.uncertainty.lede': '有些问题聊不出来。这些会被做成一次性的原型 —— 一个便宜的小东西，你对着它反应。其余留在决策层。',
      'wiz.uncertainty.needs': '需要一个原型',
      'wiz.uncertainty.decided': '对话中已定',
      'wiz.uncertainty.ticket': '原型 ticket',
      'wiz.uncertainty.branch': '落在独立分支上，保留为主源',
      'wiz.uncertainty.logic': '逻辑原型',
      'wiz.uncertainty.ui': '界面原型',
      'wiz.uncertainty.why': '为什么纸上说不清',
      'wiz.uncertainty.none': '不需要原型 —— 对话已经把一切都定了。',

      'wiz.prd.title': 'PRD 草稿',
      'wiz.prd.lede': '这是从前面几轮合成出来的，不是重新采访一遍。你审完，它就作为 spec 进 tracker。',
      'wiz.prd.project': '项目名',
      'wiz.prd.projectHint': '将创建为 {slug}',
      'wiz.prd.problem': '问题陈述',
      'wiz.prd.solution': '解决方案',
      'wiz.prd.stories': '用户故事',
      'wiz.prd.decisions': '实现决策',
      'wiz.prd.testing': '测试决策',
      'wiz.prd.seams': '测试缝',
      'wiz.prd.out': '范围外',
      'wiz.prd.storiesN': '{n} 条故事',
      'wiz.prd.seamNote': '优先用已有的缝，取最高的那个。理想的新缝数量是零。',
      'wiz.prd.approve': '通过并创建项目',
      'wiz.prd.edit': '退回继续澄清',
      'wiz.prd.glossary': '这一步产出的术语',
      'wiz.prd.adr': '值得记下的决策',

      'wiz.kind.decision': '决策 · 归你',
      'wiz.kind.fact': '事实 · agent 去查',
      'wiz.kind.prototype': '要原型',
      'wiz.kind.settled': '已定',

      'wiz.ctx.glossary': '术语表',
      'wiz.ctx.openDecisions': '待定决策',
      'wiz.ctx.factTasks': '事实调查',
      'wiz.ctx.adr': '已记 ADR',
      'wiz.ctx.terms': '{n} 个术语',
      'wiz.ctx.open': '{n} 项待定',
      'wiz.ctx.running': '{n} 个进行中',
      'wiz.ctx.none': '暂无',
      'wiz.ctx.word': '词',
      'wiz.ctx.investigating': '调查中',
      'wiz.ctx.noTasks': '现在没有要查的东西。',

      'wiz.empty.seed': '先写下你那句话。',
      'wiz.empty.frame': '先选一个读法。',
      'wiz.empty.rounds': '选了读法之后才开始轮次。',

      'toast.wizSeeded': '已记录想法 —— 正在把它读成几种不同的项目',
      'toast.wizFramed': '已选读法；下一轮问题已就绪',
      'toast.wizDest': '目标已设定；frontier 已重算',
      'toast.wizRound': '本轮已答 —— 解锁了 {n} 个新问题',
      'toast.wizFrontierEmpty': '前沿已空；没有任何东西被默默假设',
      'toast.wizAcceptAll': '已全部接受推荐',
      'toast.wizProto': '已创建 {n} 个原型 ticket，各自在自己的分支上',
      'toast.wizCreated': '项目 {name} 已创建，落在阶段 {n}',
      'toast.newProject': '已打开新建项目向导',

      /* ---- 设置 ---- */
      'set.title': '设置',
      'set.done': '完成',
      'set.cat.general': '通用',
      'set.cat.agents': 'Agent',
      'set.cat.skills': 'Skill',
      'set.cat.mcp': 'MCP 服务',
      'set.cat.credentials': '凭据',
      'set.cat.git': 'Git',
      'set.cat.automation': '自动化',
      'set.scopeNote': '作用于本工作区内的所有项目',

      'set.general.startup': '启动时打开',
      'set.general.startup.portfolio': '全部项目（总览）',
      'set.general.startup.last': '上次打开的那个项目',
      'set.general.confirm': '危险操作前先问我（强制通过、回滚、删除）',
      'set.general.cost': '在状态栏显示 token 成本',
      'set.general.telemetry': '发送匿名使用数据',
      'set.general.telemetryNote': '默认关闭。关就是关：没有任何东西离开这台机器。',

      'set.agents.runtime': '运行时',
      'set.agents.cli': 'Agent 命令行',
      'set.agents.model': '默认模型',
      'set.agents.model.inherit': '跟随当前会话',
      'set.agents.roleModels': '按角色覆盖',
      'set.agents.roleModelsNote': '除非有理由，否则留「跟随」。评审类角色用便宜模型通常没问题，写代码的那几个角色则恰恰相反。',

      'set.agents.concurrency': '并发',
      'set.agents.max': '最大并行 agent 数',
      'set.agents.maxHint': '每个 agent 都有自己的分支和自己的副本，所以两个 agent 做的事不可能撞上。这个数字限制同时跑几个。',
      'set.agents.slots': '当前分配',
      'set.agents.worker': '工作位 {n}',
      'set.agents.idle': '空闲',
      'set.agents.free': '还剩 {n} 个空位',
      'set.agents.full': '所有位都占满了',
      'set.agents.mergesInto': '并回',
      'set.agents.frontierN': '{n} 片待开工',

      'set.agents.isolation': '隔离方式',
      'set.agents.iso.worktree': 'Git worktree',
      'set.agents.iso.container': '每个 agent 一个容器',
      'set.agents.iso.vm': '每个 agent 一台虚拟机',
      'set.agents.iso.worktree.d': '最便宜，量级差距明显。共享对象库，只把工作副本分开。除非 agent 要跑不可信代码，否则就该用它。',
      'set.agents.iso.container.d': '对不可信依赖的隔离更强。启动更慢，而且需要镜像。',
      'set.agents.iso.vm.d': '完全隔离，也最重。只有代码本身不可信时才值得。',

      'set.agents.copyRoot': '工作副本放在',
      'set.agents.copyRootNote': '放在仓库之外，这样 agent 不可能把另一个 agent 的临时文件提交进去。',
      'set.agents.timeout': '阶段超时',
      'set.agents.timeoutUnit': '{n} 分钟',
      'set.agents.retries': '升级给你之前重试几次',
      'set.agents.pauseOnGate': '出现门的时候暂停所有 agent',
      'set.agents.pauseOnGateNote': '关：你答题时 agent 继续建造。开：你不答，什么都不动。',

      'set.skills.body': '一个 skill 就是编排器执行的一个工作单元。关掉一个，用到它的那个阶段就不再自动执行 —— 改成等你来。',
      'set.skills.col.skill': 'Skill',
      'set.skills.col.stage': '用在',
      'set.skills.col.source': '来源',
      'set.skills.col.state': '状态',
      'set.skills.enabled': '已启用',
      'set.skills.disabled': '已停用',
      'set.skills.none': '无 skill',
      'set.skills.onN': '已启用 {n} / {total}',
      'set.skills.manualNote': '没有 skill 的阶段是手工的，或者交给 CI。',
      'set.skills.offNote': '停用的 skill 不会运行，那个阶段会变成一道你自己处理的门。',
      'set.skills.pool': '也可用（不在主链路上）',

      'set.mcp.body': 'MCP 服务给 agent 提供文件系统之外的工具。每个服务只对需要它的阶段开放，所以某个服务的凭据永远不会流到在做别的事情的 agent 那里。',
      'set.mcp.add': '添加服务',
      'set.mcp.col.server': '服务',
      'set.mcp.col.transport': '传输',
      'set.mcp.col.scope': '开放给',
      'set.mcp.col.state': '状态',
      'set.mcp.connected': '已连接',
      'set.mcp.error': '出错',
      'set.mcp.off': '已停用',
      'set.mcp.env': '{n} 个环境变量',
      'set.mcp.test': '测试',
      'set.mcp.remove': '移除',
      'set.mcp.scopeAll': '所有阶段',
      'set.mcp.errNote': '这个服务上次握手失败。需要它的 agent 会停在一道门上，而不是缺着工具硬跑。',

      'set.cred.body': '密钥存在操作系统钥匙串里 —— 不进仓库，也不进任何可能被提交的文件。agent 在运行时通过钥匙串读取。',
      'set.cred.col.provider': '提供方',
      'set.cred.col.stored': '存放位置',
      'set.cred.col.usedBy': '使用者',
      'set.cred.keychain': '系统钥匙串',
      'set.cred.ci': 'CI 密钥',
      'set.cred.add': '添加密钥',
      'set.cred.rotate': '轮换',
      'set.cred.warn': '一个被贴进仓库的密钥，就是一个你必须轮换的密钥。防止这件事发生，正是 /wizard 这个 skill 存在的意义。',

      'set.git.body': '工作怎么分支出去，又怎么合回来。',
      'set.git.branch': '切片的 branch 名',
      'set.git.branchNote': '{ticket} 会替换成 ticket id，这样从 branch 找得到 ticket，反过来也行。',
      'set.git.integration': '集成分支',
      'set.git.sign': '签名提交',
      'set.git.pr': '集成分支有第一个合并之后就开草稿 PR',
      'set.git.cleanup': '切片合并后删掉那个 agent 的工作副本',

      'set.auto.body': '你没在看的时候会发生什么。',
      'set.auto.afk': '以 AFK 模式启动',
      'set.auto.autoMerge': '门一通过就自动把该切片并进集成分支',
      'set.auto.autoMergeNote': '关：门会排着队等你，没有东西会在没人看的时候合并。这是更安全的默认值。',
      'set.auto.maxWait': '门等待超过 {n} 小时就升级给我',
      'set.auto.summary': '每天 09:00 发一份摘要',

      'set.crumb.thisMachine': '这台机器',
      'set.applies': '改动即时保存',

      'toast.setSaved': '{label} 已更新',
      'toast.setClamped': '最大并行数需在 {min}–{max} 之间；已设为 {n}',
      'toast.skillOff': '{name} 已停用 —— 那个阶段现在归你',
      'toast.skillOn': '{name} 已启用',
      'toast.mcpAdded': '{name} 已添加；尚未连接',
      'toast.mcpRemoved': '{name} 已从所有阶段移除',
      'toast.mcpTested': '{name}：{result}',
      'toast.credRotate': '{provider} 的轮换已开始',

      'toast.advance': '已推进到下一阶段（原型）',
      'toast.rerun': '已重跑当前阶段',
      'toast.afkOn': 'AFK 模式已开启 — agent 跑到下一个阻塞点才叫你',
      'toast.afkOff': 'AFK 模式已关闭',
      'toast.approveAll': '已通过 {project} 的 {n} 个阻塞门，agent 继续往下跑',
      'toast.approveNone': '当前项目没有待处理的门',
      'toast.pauseAll': '已暂停全部 agent',
      'toast.rescan': '已重新扫描 .scratch/ 与 tracker，记录刷新',
      'toast.copyDossier': '阶段档案已拷贝为 markdown',
      'toast.exportAudit': '审计表已导出为 CSV',
      'toast.newProject': '已打开新建项目向导',
      'toast.openWs': '已打开工作区选择器',
      'toast.importRepo': '已打开仓库导入',
      'toast.settings': '已打开项目设置',
      'toast.gateDefaults': '已打开门的默认配置',
      'toast.roles': '已打开角色分派',
      'toast.gateCreated': '验收门已挂到 {project} 的「{scope}」，验收人：{owner}',
      'toast.enteredInbox': '已进入 {project} 的收件箱',
      'toast.scopePortfolio': '已切换到全部项目',
      'toast.scopeProject': '已切换到 {name}',
      'toast.blocked': '门已通过，agent 继续',
      'toast.handled': '已按要求处理',
      'toast.locale': '语言已切换为 {label}'
    }
  };

  /* ---- stage vocabulary (shared by pipeline, roadmap, dossiers) ---- */
  var STAGES = [
    { k: 's1', en: 'Concept init', zh: '概念初始化', enS: 'Concept', zhS: '概念' },
    { k: 's2', en: 'Requirements', zh: '需求澄清', enS: 'Clarify', zhS: '澄清' },
    { k: 's3', en: 'Uncertainty', zh: '不确定项验证', enS: 'Verify', zhS: '验证' },
    { k: 's4', en: 'Spec', zh: '规格', enS: 'Spec', zhS: '规格' },
    { k: 's5', en: 'Ticketing', zh: '拆片', enS: 'Slice', zhS: '拆片' },
    { k: 's6', en: 'Build (AFK)', zh: '建造（AFK）', enS: 'Build', zhS: '建造' },
    { k: 's7', en: 'Acceptance', zh: '验收', enS: 'Accept', zhS: '验收' },
    { k: 's8', en: 'Release', zh: '发布', enS: 'Release', zhS: '发布' },
    { k: 's9', en: 'Retro', zh: '复盘', enS: 'Retro', zhS: '复盘' }
  ];
  STAGES.forEach(function (s) {
    DICT.en['stage.' + s.k] = s.en; DICT.zh['stage.' + s.k] = s.zh;
    DICT.en['stageshort.' + s.k] = s.enS; DICT.zh['stageshort.' + s.k] = s.zhS;
  });

  var current = FALLBACK;
  var listeners = [];

  var storage = {
    get: function (k) {
      try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null; }
      catch (e) { return null; }
    },
    set: function (k, v) {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v); }
      catch (e) { /* private mode, RN, etc. */ }
    }
  };

  function has(locale) { return Object.prototype.hasOwnProperty.call(DICT, locale); }

  function meta(locale) {
    for (var i = 0; i < META.length; i++) if (META[i].code === (locale || current)) return META[i];
    return META[0];
  }

  function interpolate(s, params) {
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] !== undefined && params[k] !== null ? String(params[k]) : m;
    });
  }

  function t(key, params) {
    var table = DICT[current] || DICT[FALLBACK];
    var s = table[key];
    if (s === undefined) s = DICT[FALLBACK][key];
    if (s === undefined) return key;
    return params ? interpolate(s, params) : s;
  }

  /* Localized content field. Accepts a string, an { en, zh } object, or an
   * array of either (joined with a middot). */
  function pick(value, sep) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) {
      return value.map(function (v) { return pick(v, null); })
        .filter(function (s) { return s !== ''; })
        .join(sep === undefined ? ' · ' : sep);
    }
    if (typeof value === 'string') return value;
    if (value[current] !== undefined) return value[current];
    if (value[FALLBACK] !== undefined) return value[FALLBACK];
    return Object.keys(value).length ? String(value[Object.keys(value)[0]]) : '';
  }

  function setLocale(locale, opts) {
    if (!has(locale)) return current;
    var changed = locale !== current;
    current = locale;
    if (!opts || opts.persist !== false) storage.set(STORAGE_KEY, locale);
    if (changed) listeners.forEach(function (fn) { try { fn(current); } catch (e) {} });
    return current;
  }

  function next() {
    var i = META.map(function (m) { return m.code; }).indexOf(current);
    return setLocale(META[(i + 1) % META.length].code);
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* Boot. Order: explicit stored choice > platform language (opt-in) > fallback.
   * The base language is English; platform detection is opt-in via
   * init({ usePlatform: true }) so a build can pin one language if it wants. */
  function init(opts) {
    opts = opts || {};
    if (opts.storage) storage = opts.storage;
    var stored = opts.stored !== undefined ? opts.stored : storage.get(STORAGE_KEY);
    if (stored && has(stored)) return setLocale(stored, { persist: false });
    var nav = '';
    if (opts.usePlatform) {
      nav = opts.language ||
        (typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || '';
    }
    var guess = /^zh/i.test(nav) ? 'zh' : FALLBACK;
    return setLocale(guess, { persist: false });
  }

  function configure(opts) { if (opts && opts.storage) storage = opts.storage; }

  return {
    t: t, pick: pick, setLocale: setLocale, getLocale: function () { return current; },
    next: next, subscribe: subscribe, init: init, configure: configure,
    isLocale: has, meta: meta, supported: function () { return META.slice(); },
    fallback: FALLBACK, DICT: DICT
  };
});
