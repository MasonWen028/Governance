/**
 * Skill packs: two sets of capability slots the framework wants filled.
 *
 * The design problem this module answers is not "which skills do we like". It is
 * "how does a stage know that the skill installed for it does the job it is
 * bound to". A settings file that records `agentic-actions-auditor` for the
 * quality-gate layer and a skill that audits GitHub Actions for prompt injection
 * are two different things, and only the second one is visible from disk.
 *
 * So a slot is a *contract*, not a name:
 *
 * - `mustMatch` says what the skill's own text has to say about itself;
 * - `mustNotMatch` is the veto — the one rule that catches a plausible name
 *   attached to the wrong job;
 * - `wants` is the ordered list of skills that would satisfy it, so a substitution
 *   is expressed as data rather than as a special case;
 * - `source` is where to get the first choice, and `null` when no upstream could
 *   be verified. A fabricated URL would install the wrong thing with confidence,
 *   which is worse than an honest gap: the gap offers a substitution, the
 *   fabrication does not.
 *
 * The contracts are checked against what is actually on disk (`verifySkill`), so
 * a slot cannot be marked satisfied by a setting. That is the whole point — a
 * setting is a claim, and this module exists to check claims.
 */

/** One pattern plus the sentence a human reads when it fires. */
export interface Rule {
  readonly pattern: RegExp;
  readonly weight: number;
  readonly why: string;
}

export interface SkillContract {
  readonly mustMatch: readonly Rule[];
  /**
   * Rules the skill's own description has to satisfy, whatever its score.
   *
   * Added after a real false positive: `hig-foundations` scored 8 against the
   * quality-gate slot, because "Human Interface Guidelines" matched "interface"
   * and its accessibility coverage is genuine. A foundations skill was about to
   * fill a *review* slot and read as green, and an additive score cannot express
   * "this slot's job is reviewing" — a single heavy rule can carry a slot on its
   * own.
   *
   * Checked against the frontmatter description only, and that is the point: a
   * description is where a skill declares what it is for, while a body mentions
   * adjacent work in passing. A skill that reviews things says so.
   */
  readonly mustInclude?: readonly Rule[];
  /** A hit here rejects the skill whatever its score. This is the rule that
   *  keeps a DevOps skill out of a design slot. */
  readonly mustNotMatch: readonly Rule[];
  /** Below this, the skill is the wrong tool even without a veto. */
  readonly minScore: number;
}

/** Where a slot's skill comes from, when somewhere was verified to exist. */
export interface SkillSource {
  /** `owner/name` on GitHub. */
  readonly repo: string;
  /**
   * Directory names to accept after cloning, checked for a `SKILL.md`.
   *
   * Not a path: repositories re-organise (`skills/x`, `plugins/y/skills/x`), and
   * a hard-coded path would either break or, worse, resolve to a directory that
   * happens to exist and is not the skill. Scanning for the name and requiring
   * the file is the check that survives a move.
   */
  readonly expect: readonly string[];
}

export interface PackEntry {
  /** Stable id, `layer.role`. The settings file keys substitutions by this. */
  readonly slot: string;
  /** 1-based position in the pack, for presentation only. */
  readonly layer: number;
  /** False for the "advanced" rung a pack works without. */
  readonly required: boolean;
  /** Acceptable skills in preference order, by directory name. */
  readonly wants: readonly string[];
  readonly source: SkillSource | null;
  /** Why `source` is null, when it is. Shown in the interface, because "we could
   *  not find it" and "we did not look" are different facts. */
  readonly unresolved?: string;
  readonly contract: SkillContract;
}

export interface SkillPack {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly PackEntry[];
}

/* ------------------------------------------------------------------ */
/* Contracts                                                            */
/* ------------------------------------------------------------------ */

/**
 * The veto for a design slot.
 *
 * Everything here is "this skill is about shipping software, not about how it
 * looks". `agentic-actions-auditor` is the case that prompted the list: its name
 * says "auditor", the quality-gate slot says "review", and the two words are not
 * the same job. It mentions GitHub Actions in its first sentence, so it is
 * rejected before its score is even consulted.
 *
 * This is deliberately the only shared vocabulary in the file. What a slot
 * *wants* is specific to that slot and is written out per entry; what disqualifies
 * a skill is the same across the whole pack, and writing it five times would be
 * five chances to write it differently.
 */
const DESIGN_VETO: readonly Rule[] = [
  { pattern: /\bgithub actions?\b/i, weight: 0, why: 'it is about GitHub Actions workflows' },
  { pattern: /\.github\/workflows/i, weight: 0, why: 'it edits workflow YAML' },
  { pattern: /\bsecurity audit|\bvulnerabilit|\bthreat model|\bCVE\b|\bprompt injection\b/i, weight: 0, why: 'it audits security, it does not review design' },
  { pattern: /\bCI\/CD\b|\bcontinuous (delivery|integration)\b/i, weight: 0, why: 'it is a delivery pipeline skill' },
  { pattern: /\bdockerfile\b|\bcontainer image\b|\bterraform\b|\bkubernetes\b|\bhelm chart\b/i, weight: 0, why: 'it is infrastructure, not interface' },
  { pattern: /\bdeploy(ment)? (pipeline|workflow|strategy)\b|\brollback\b/i, weight: 0, why: 'it is a deployment skill' },
];

/** The mirror image: a design skill must not fill a delivery slot. */
const DEVOPS_VETO: readonly Rule[] = [
  { pattern: /\btypograph|\btype scale\b/i, weight: 0, why: 'it is about type, not delivery' },
  { pattern: /\bcolou?r palette\b|\bvisual hierarchy\b|\bwhitespace\b/i, weight: 0, why: 'it is about visual composition' },
  { pattern: /\bmicro-?interaction/i, weight: 0, why: 'it is about interaction detail' },
  { pattern: /\bhuman interface guidelines\b|\bapple hig\b/i, weight: 0, why: 'it is an Apple design skill' },
  { pattern: /\bhero section\b|\bscrollytelling\b/i, weight: 0, why: 'it designs pages, it does not deliver them' },
];

/** Narrower contracts, for layers whose job is more specific than "design". */
const MOTION_CONTRACT: SkillContract = {
  mustMatch: [
    { pattern: /\banimation|\bmotion|\btransition|\beasing\b/i, weight: 3, why: 'it is about motion' },
    { pattern: /\binteraction\b|\binteractive\b/i, weight: 2, why: 'it is about interaction' },
    { pattern: /\bduration\b|\bspring\b|\btransform\b/i, weight: 1, why: 'it names the mechanics' },
    { pattern: /\bdesign\b|\binterface\b|\bUI\b/i, weight: 1, why: 'it works on interfaces' },
  ],
  mustInclude: [
    { pattern: /\banimation|\bmotion|\binteraction|\btransition|\beasing\b/i, weight: 0, why: 'it works on motion or interaction' },
  ],
  mustNotMatch: DESIGN_VETO,
  minScore: 4,
};

/* ------------------------------------------------------------------ */
/* The packs                                                            */
/* ------------------------------------------------------------------ */

/**
 * Five layers of interface work, each with a different job.
 *
 * The order is the order the work happens in, and that is the reason to keep
 * them separate rather than merging them into one "design" skill: picking
 * components, choosing a visual direction, engineering the motion, gating the
 * result, and polishing it at the end are five different moments, and a single
 * skill that claims all five is a single skill that does none of them carefully.
 */
const DESIGN_STACK: SkillPack = {
  id: 'design-stack',
  title: 'Apple-inspired Design Stack',
  entries: [
    {
      slot: 'design.foundation',
      layer: 1,
      required: true,
      wants: ['hig-foundations', 'apple-design', 'hig-patterns'],
      source: { repo: 'raintree-technology/hig-doctor', expect: ['hig-foundations'] },
      contract: {
        mustMatch: [
          { pattern: /\bhuman interface guidelines\b|\bHIG\b/i, weight: 3, why: 'it names the HIG' },
          { pattern: /\bprinciples?\b|\bfoundations?\b/i, weight: 2, why: 'it covers principles' },
          { pattern: /\bcomponent|\bcontrol/i, weight: 1, why: 'it covers component choice' },
          { pattern: /\btypograph|\bcolou?r|\blayout|\bmaterials?\b/i, weight: 1, why: 'it covers the visual vocabulary' },
        ],
        mustInclude: [
          { pattern: /\bhuman interface guidelines\b|\bHIG\b|\bapple\b/i, weight: 0, why: 'it works from the Apple guidelines' },
        ],
        mustNotMatch: DESIGN_VETO,
        minScore: 5,
      },
    },
    {
      slot: 'design.visual',
      layer: 2,
      required: true,
      wants: ['frontend-design'],
      source: { repo: 'anthropics/skills', expect: ['frontend-design'] },
      contract: {
        mustMatch: [
          { pattern: /\btypograph|\bfont|\btypeface\b/i, weight: 2, why: 'it sets type' },
          { pattern: /\bcolou?r\b|\bpalette\b/i, weight: 2, why: 'it sets colour' },
          { pattern: /\blayout\b|\bspacing\b|\bgrid\b/i, weight: 2, why: 'it works on layout' },
          { pattern: /\bvisual\b|\bdirection\b|\baesthetic\b/i, weight: 2, why: 'it sets a visual direction' },
          { pattern: /\bfrontend\b|\bUI\b|\binterface\b/i, weight: 1, why: 'it builds interfaces' },
        ],
        /* Concrete visual decisions, not the adjective. "Layout" alone is a word
         * that describes a repository's directory tree as readily as a page, and
         * a score built from it nominated `/ask-matt` for visual direction. */
        mustInclude: [
          { pattern: /\btypograph|\bfont\b|\btypeface\b|\bcolou?r\b|\bpalette\b/i, weight: 0, why: 'it makes type or colour decisions' },
        ],
        mustNotMatch: DESIGN_VETO,
        minScore: 5,
      },
    },
    {
      slot: 'design.interaction',
      layer: 3,
      required: true,
      wants: ['emil-design-eng', 'animate', 'improve-animations'],
      source: { repo: 'emilkowalski/skills', expect: ['emil-design-eng'] },
      contract: MOTION_CONTRACT,
    },
    {
      /* The Microsoft review skill this layer was specified from does not exist
       * upstream. This is the nearest thing that does, and it is a genuine
       * interface review rather than a lookalike: usability, hierarchy,
       * consistency and accessibility, with severity-ranked findings. */
      slot: 'design.gate',
      layer: 4,
      required: true,
      wants: ['design-critique', 'ux-ui-principles-audit'],
      source: { repo: 'findscripter/everything-skills', expect: ['design-critique'] },
      contract: {
        mustMatch: [
          { pattern: /\breview|\bcritique|\baudit\b|评审|审阅|审查|审计|体检/i, weight: 3, why: 'it reviews a page' },
          { pattern: /\baccessibilit|\ba11y\b|\bWCAG\b|\bcontrast\b|无障碍|可访问/i, weight: 3, why: 'it checks accessibility' },
          { pattern: /\bconsisten|\bdesign system\b|\btokens?\b|一致性|设计系统|规范/i, weight: 2, why: 'it checks consistency' },
          /* `设计` is deliberately absent: in Chinese software writing "设计审查"
           * is at least as often a review of code architecture as of an
           * interface, and `brooks-design-lint` uses it that way. */
          { pattern: /\bUI\b|\binterface\b|\bpage\b|\bfrontend\b|界面|页面|前端|视觉稿|屏幕/i, weight: 1, why: 'it reviews an interface' },
        ],
        mustInclude: [
          { pattern: /\breview|\bcritique|\baudit\b|评审|审阅|审查|审计|体检/i, weight: 0, why: 'it is a review pass over an interface' },
          /* Both halves, because each one alone is satisfied by something else:
           * "review" by `/code-review`, "interface" by every design skill. The
           * slot is a review *of an interface*, and the description has to say
           * so before the score is worth reading.
           *
           * The Chinese terms are here for the same reason as the English ones:
           * most of the skills in this ecosystem are written in Chinese, and a
           * checker that only reads English refuses them for a language reason
           * while claiming their content is wrong. */
          { pattern: /\bUI\b|\binterface\b|\bpage\b|\bfrontend\b|界面|页面|前端|视觉稿|屏幕/i, weight: 0, why: 'it reviews an interface' },
        ],
        mustNotMatch: DESIGN_VETO,
        minScore: 6,
      },
    },
    {
      slot: 'design.polish',
      layer: 5,
      required: true,
      wants: ['make-interfaces-feel-better'],
      source: {
        repo: 'jakubkrehel/make-interfaces-feel-better',
        expect: ['make-interfaces-feel-better'],
      },
      contract: {
        mustMatch: [
          { pattern: /\bpolish|\bfeel\b|\bfeels\b|\bdetail/i, weight: 3, why: 'it is about how the interface feels' },
          { pattern: /\bfinish|\bdelight|\bsubtle\b/i, weight: 2, why: 'it is about finish' },
          { pattern: /\bUI\b|\binterface\b|\binteraction\b/i, weight: 2, why: 'it works on interfaces' },
        ],
        /* "feels" and "detail" are words every skill uses — `/prototype` matched
         * on "whether a state model or logic feels right", `/tdd` on "details".
         * Polish has to be the declared subject, not a word that appears in the
         * description on the way to something else. */
        mustInclude: [
          { pattern: /\bpolish|\bfeel better\b|\bdelight|\bfinish\b|\bmicro-?details?\b/i, weight: 0, why: 'polish is what it is for' },
        ],
        mustNotMatch: DESIGN_VETO,
        minScore: 5,
      },
    },
  ],
};

/**
 * Six slots for getting code out of the repository and into production.
 *
 * `agentic-actions-auditor` is the only member whose upstream was verified, and
 * it is the reason the contracts exist: it is a *security* skill, and its job is
 * to be bound to the audit slot and to nothing else. The others are named after
 * the capability rather than after an author, so any installed skill that does
 * the job can be substituted in.
 */
const DEVOPS_SUITE: SkillPack = {
  id: 'devops-suite',
  title: 'CI/CD DevOps Suite',
  entries: [
    {
      slot: 'devops.workflows',
      layer: 1,
      required: true,
      wants: ['github-actions-author', 'github-actions'],
      source: { repo: 'findscripter/everything-skills', expect: ['github-actions-author'] },
      contract: {
        mustMatch: [
          { pattern: /\bgithub actions?\b/i, weight: 3, why: 'it writes GitHub Actions' },
          { pattern: /\bworkflow|\bjob\b|\bmatrix\b/i, weight: 2, why: 'it authors workflows' },
          { pattern: /\byaml\b|\byml\b/i, weight: 1, why: 'it writes workflow YAML' },
          { pattern: /\btrigger|\bschedule|\bcache\b/i, weight: 1, why: 'it configures triggers' },
        ],
        /* "workflow" is a word about specs and loops as much as about Actions —
         * `/loop-me` claims workflows and has never seen a `.github` directory.
         * The slot is GitHub Actions, and the description has to name it. */
        mustInclude: [
          { pattern: /\bgithub actions?\b/i, weight: 0, why: 'it writes GitHub Actions' },
        ],
        mustNotMatch: DEVOPS_VETO,
        minScore: 5,
      },
    },
    {
      slot: 'devops.pipeline',
      layer: 2,
      required: true,
      wants: ['ci-pipelines', 'ci'],
      source: { repo: 'anmolnagpal/devops-skills', expect: ['ci'] },
      contract: {
        mustMatch: [
          { pattern: /\bpipeline/i, weight: 3, why: 'it builds pipelines' },
          { pattern: /\bbuild\b|\bcompile|\btest/i, weight: 2, why: 'it covers build and test' },
          { pattern: /\bcontinuous integration\b|\bCI\b/i, weight: 2, why: 'it is CI' },
          { pattern: /\bcache|\bmatrix|\bartifact/i, weight: 1, why: 'it optimises the pipeline' },
        ],
        /* Not "build and test", which any skill about making software says —
         * `/wizard` matched it on "setting up credentials or CI secrets". A
         * pipeline skill names the pipeline. */
        mustInclude: [
          { pattern: /\bpipeline\b|\bgithub actions?\b/i, weight: 0, why: 'it works on a pipeline' },
        ],
        mustNotMatch: DEVOPS_VETO,
        minScore: 5,
      },
    },
    {
      slot: 'devops.image',
      layer: 3,
      required: true,
      wants: ['docker', 'docker-compose'],
      source: { repo: 'anmolnagpal/devops-skills', expect: ['docker'] },
      contract: {
        mustMatch: [
          { pattern: /\bdockerfile|\bimage\b/i, weight: 3, why: 'it builds images' },
          { pattern: /\bcontainer/i, weight: 2, why: 'it works with containers' },
          { pattern: /\bcompose\b|\bmulti-?stage\b|\blayer cache\b/i, weight: 2, why: 'it covers composition and image size' },
          { pattern: /\bregistry\b|\btag\b|\bpush\b/i, weight: 1, why: 'it publishes images' },
        ],
        mustInclude: [
          { pattern: /\bdocker|\bcontainer|\bimage\b/i, weight: 0, why: 'it builds container images' },
        ],
        mustNotMatch: DEVOPS_VETO,
        minScore: 5,
      },
    },
    {
      slot: 'devops.release',
      layer: 4,
      required: true,
      wants: ['continuous-delivery', 'deploy', 'gitops'],
      source: { repo: 'anmolnagpal/devops-skills', expect: ['deploy'] },
      contract: {
        mustMatch: [
          { pattern: /\bdeployment strategy|\brelease strategy\b|\bcontinuous (delivery|deployment)\b|\bprogressive delivery\b/i, weight: 3, why: 'it decides how to ship' },
          { pattern: /\brollback|\bcanary\b|\bblue[- ]green\b|\bprogressive (delivery|rollout)\b/i, weight: 3, why: 'it names a way to ship safely' },
          { pattern: /\bproduction[- ]readiness|\bready to ship\b|\bpre-deploy\b|\bgo[- ]live\b/i, weight: 2, why: 'it gates readiness' },
          { pattern: /\brelease\b|\bdeploy/i, weight: 1, why: 'it releases' },
        ],
        /* Layer 2 already owns mechanical promotion — `/ci` adds the deploy job
         * and fixes staging sharing production's credentials. Asking this layer
         * for promotion vocabulary as well would make layers 2 and 4 the same
         * job twice, and `/ci` would substitute into both. Layer 4 is the
         * *decision* about how to ship: strategy, readiness, rollback.
         *
         * The first version of this rule demanded "moves a build between
         * environments" and rejected the very skill the catalogue names.
         * `deploy` says "Deployment strategy, production-readiness gating, and
         * rollback planning" — this layer's job, in its own words. The rule was
         * written from an idea of continuous delivery, before there was a
         * candidate to read. */
        mustInclude: [
          {
            pattern: /\bdeployment strategy|\brelease strategy\b|\brollback|\bcanary\b|\bblue[- ]green\b|\bprogressive (delivery|rollout)\b|\bproduction[- ]readiness\b|\bpre-deploy\b/i,
            weight: 0,
            why: 'it declares a way to ship safely',
          },
        ],
        mustNotMatch: DEVOPS_VETO,
        minScore: 5,
      },
    },
    {
      slot: 'devops.deploy',
      layer: 5,
      required: false,
      wants: ['deployment-engineer'],
      source: { repo: 'agent-skills-hub/agent-skills-hub', expect: ['deployment-engineer'] },
      contract: {
        mustMatch: [
          { pattern: /\bdeploy|\brollout\b/i, weight: 3, why: 'it deploys' },
          { pattern: /\bzero[- ]downtime|\bblue[- ]green|\bcanary|\brolling\b/i, weight: 3, why: 'it names a deployment strategy' },
          { pattern: /\brollback|\bhealth check|\bprobe\b/i, weight: 2, why: 'it covers rollback and health' },
          { pattern: /\bkubernetes|\bhelm|\bterraform|\bcloud\b/i, weight: 1, why: 'it targets infrastructure' },
        ],
        mustInclude: [
          { pattern: /\bdeploy|\brollout|\bzero[- ]downtime|\brelease\b/i, weight: 0, why: 'it deploys' },
        ],
        mustNotMatch: DEVOPS_VETO,
        minScore: 6,
      },
    },
    {
      slot: 'devops.audit',
      layer: 6,
      required: true,
      wants: ['agentic-actions-auditor'],
      source: { repo: 'trailofbits/skills', expect: ['agentic-actions-auditor'] },
      contract: {
        mustMatch: [
          { pattern: /\bgithub actions?\b/i, weight: 3, why: 'it audits GitHub Actions' },
          { pattern: /\bsecurity|\bvulnerabilit|\battack vector|\binjection\b/i, weight: 3, why: 'it audits security' },
          { pattern: /\bworkflow/i, weight: 1, why: 'it reads workflow files' },
          { pattern: /\bagent|\bAI\b|\bLLM\b/i, weight: 1, why: 'it audits agent integrations' },
        ],
        mustInclude: [
          { pattern: /\baudit|\bsecurity|\bvulnerabilit|\binjection\b/i, weight: 0, why: 'it audits security' },
        ],
        mustNotMatch: DEVOPS_VETO,
        minScore: 6,
      },
    },
  ],
};

/** One slot. The job is the *smallest change that fully solves the task* —
 * which is also what keeps a reply, and therefore a token bill, small. */
const CODE_DISCIPLINE: SkillPack = {
  id: 'code-discipline',
  title: 'Code Discipline',
  entries: [
    {
      slot: 'code.brevity',
      layer: 1,
      required: true,
      wants: ['ponytail'],
      source: { repo: 'DietrichGebert/ponytail', expect: ['ponytail'] },
      contract: {
        mustMatch: [
          { pattern: /\bsmallest change|\bsimplest solution|\byagni\b|\bless code\b/i, weight: 3, why: 'it minimises the change' },
          { pattern: /\bover-?engineering|\bbloat\b/i, weight: 3, why: 'it resists bloat' },
          { pattern: /\brefactor|\bcoding task|\bfixing\b/i, weight: 2, why: 'it works on code' },
          { pattern: /\bone read|\breply\b|\btokens?\b/i, weight: 1, why: 'it keeps the answer small' },
        ],
        /* Every skill about code "works on code". This slot's job is writing
         * less of it, and the description has to say so — the first draft
         * accepted anything that mentioned refactoring. */
        mustInclude: [
          { pattern: /\bsmallest change|\bsimplest solution|\byagni\b|\bless code\b/i, weight: 0, why: 'it commits to writing less' },
        ],
        mustNotMatch: DEVOPS_VETO,
        minScore: 5,
      },
    },
  ],
};

export const DEFAULT_PACKS: readonly SkillPack[] = [DESIGN_STACK, DEVOPS_SUITE, CODE_DISCIPLINE];

export function packById(id: string): SkillPack | null {
  return DEFAULT_PACKS.find((p) => p.id === id) ?? null;
}

export function entryBySlot(packId: string, slot: string): PackEntry | null {
  const pack = packById(packId);
  return pack?.entries.find((e) => e.slot === slot) ?? null;
}

/* ------------------------------------------------------------------ */
/* Verification                                                         */
/* ------------------------------------------------------------------ */

export type SkillStatus = 'match' | 'mismatch' | 'missing';

export interface SkillVerification {
  readonly id: string;
  readonly status: SkillStatus;
  /** Description hits count double; see `verifySkill`. */
  readonly score: number;
  /** Why it passed, in the skill's own terms. Empty on a mismatch. */
  readonly reasons: readonly string[];
  /** Hard vetoes that fired. One of these is enough on its own. */
  readonly rejected: readonly string[];
}

/** Split a `SKILL.md` into its frontmatter description and its body. */
function splitSkill(raw: string): { description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const head = match?.[1] ?? '';
  const body = match === null ? raw : raw.slice(match[0].length);
  return { description: descriptionOf(head), body };
}

/**
 * Read the `description` out of frontmatter, including its multiline forms.
 *
 * YAML allows three shapes for one field, and real skills use all three:
 *
 *     description: one line
 *     description: >-            # folded block, the common case for a long one
 *       first line
 *       second line
 *     description: |             # literal block
 *
 * The first version matched `^description:\s*(.*)$` and stopped there, so a
 * folded block parsed as the literal two characters `>-`. `hig-foundations`
 * writes its description that way, and the checker consequently reported that a
 * file opening with "Apple Human Interface Guidelines design foundations" never
 * mentions the Apple guidelines — a false statement about a file it had just read.
 */
function descriptionOf(head: string): string {
  const lines = head.split(/\r?\n/);
  const start = lines.findIndex((l) => /^description:/.test(l));
  if (start < 0) return '';

  const first = (lines[start] ?? '').slice('description:'.length).trim();
  const block = /^[>|][-+]?$/.test(first);
  const parts: string[] = [];
  /* For a block scalar the marker is not content; for a plain scalar the first
   * line is. */
  if (!block && first.length > 0) parts.push(first);

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // A line at column zero is the next key, which ends this field.
    if (/^\S/.test(line)) break;
    const text = line.trim();
    if (text.length > 0) parts.push(text);
  }

  /* Joined with spaces either way: the caller reads this with regular
   * expressions, and a folded block means exactly that — the newlines are not
   * content. */
  return parts.join(' ').replace(/^["']|["']$/g, '');
}

/**
 * Judge one skill against one slot's contract.
 *
 * `raw` is null when the skill is not installed, which is a distinct answer from
 * "installed and wrong": the first can be fixed by installing it, the second
 * cannot.
 *
 * The description is weighted double because it is the author's own statement of
 * what the skill is for, while a long body mentions adjacent topics in passing.
 * A veto fires on either, because a skill whose body audits GitHub Actions is a
 * DevOps skill however its description opens.
 */
export function verifySkill(
  id: string,
  raw: string | null,
  contract: SkillContract,
): SkillVerification {
  if (raw === null) {
    return { id, status: 'missing', score: 0, reasons: [], rejected: [] };
  }
  const { description, body } = splitSkill(raw);

  /* Bytes, not tokens: 6 kB is several pages of a SKILL.md, which is where the
   * subject of a skill is settled. A longer body is a reference appendix, and
   * vetoing on one is the only thing that window could get wrong. */
  const sample = `${description}\n${body.slice(0, 6000)}`;

  const rejected = contract.mustNotMatch
    .filter((r) => r.pattern.test(sample))
    .map((r) => r.why);

  const reasons: string[] = [];
  let score = 0;
  for (const rule of contract.mustMatch) {
    if (rule.pattern.test(description)) {
      score += rule.weight * 2;
      reasons.push(`${rule.why} (in its own description)`);
    } else if (rule.pattern.test(body)) {
      score += rule.weight;
      reasons.push(rule.why);
    }
  }

  if (rejected.length > 0) {
    /* The veto wins outright. A security skill can score well on "review" and
     * "audit" and still be the wrong answer to a design gate, which is precisely
     * the mistake a score alone cannot catch. */
    return { id, status: 'mismatch', score, reasons: [], rejected };
  }

  const absent = (contract.mustInclude ?? []).filter((r) => !r.pattern.test(description));
  if (absent.length > 0) {
    /* Scored well, still refused: the skill does not claim this job. Reported
     * with the same field as a veto because, from the caller's side, both mean
     * "this skill cannot fill this slot", and both need the sentence. */
    return {
      id,
      status: 'mismatch',
      score,
      reasons,
      rejected: absent.map((r) => `it never says ${r.why}`),
    };
  }

  if (score < contract.minScore) {
    return { id, status: 'mismatch', score, reasons, rejected };
  }
  return { id, status: 'match', score, reasons, rejected };
}

/* ------------------------------------------------------------------ */
/* Resolution                                                           */
/* ------------------------------------------------------------------ */

/** One slot, resolved against what the machine actually has. */
export interface SlotState {
  readonly slot: string;
  readonly layer: number;
  readonly required: boolean;
  /** The skill filling the slot, or null when nothing does. */
  readonly skill: string | null;
  readonly status: SkillStatus | 'unresolved' | 'substituted';
  readonly candidates: readonly string[];
  readonly reasons: readonly string[];
  readonly rejected: readonly string[];
  readonly source: SkillSource | null;
  readonly unresolved: string | null;
  /** True when the skill was chosen by a stored substitution rather than by
   *  matching `wants`. */
  readonly substituted: boolean;
}

export interface PackState {
  readonly id: string;
  readonly title: string;
  readonly required: number;
  readonly satisfied: number;
  /** Every required slot is filled by a skill that passed its own contract. */
  readonly ready: boolean;
  readonly entries: readonly SlotState[];
}

export interface ResolveInput {
  /** Installed skills by directory name, with their `SKILL.md` text. */
  readonly installed: ReadonlyMap<string, string>;
  /** Stored substitutions: slot -> skill id. */
  readonly substitutions?: Readonly<Record<string, string>>;
}

function resolveEntry(
  entry: PackEntry,
  input: ResolveInput,
  allowSubstitution = true,
): SlotState {
  const base = {
    slot: entry.slot,
    layer: entry.layer,
    required: entry.required,
    source: entry.source,
    unresolved: entry.unresolved ?? null,
  };

  /* A stored substitution is honoured first, and then *checked*. A setting is a
   * claim about equivalence; the contract is what decides whether it is true. */
  const chosen = allowSubstitution ? input.substitutions?.[entry.slot] : undefined;
  if (chosen !== undefined && chosen.length > 0) {
    const raw = input.installed.get(chosen) ?? null;
    const verdict = verifySkill(chosen, raw, entry.contract);
    if (verdict.status === 'match') {
      return {
        ...base,
        skill: chosen,
        status: 'substituted',
        candidates: [chosen],
        reasons: verdict.reasons,
        rejected: [],
        substituted: true,
      };
    }
    /* A substitution that no longer holds — the skill was removed, or replaced
     * by one with the same name — falls back to the pack's own preference rather
     * than leaving the slot dark. */
    return resolveEntry(entry, input, false);
  }

  for (const want of entry.wants) {
    const raw = input.installed.get(want);
    if (raw === undefined) continue;
    const verdict = verifySkill(want, raw, entry.contract);
    if (verdict.status === 'match') {
      return {
        ...base,
        skill: want,
        status: 'match',
        candidates: [want],
        reasons: verdict.reasons,
        rejected: [],
        substituted: false,
      };
    }
    /* Installed but wrong. Worth reporting: it is the case where the machine has
     * a skill by the right name and the wrong contents. */
    return {
      ...base,
      skill: null,
      status: 'mismatch',
      candidates: entry.wants.filter((w) => input.installed.has(w)),
      reasons: verdict.reasons,
      rejected: verdict.rejected,
      substituted: false,
    };
  }

  return {
    ...base,
    skill: null,
    status: entry.source === null ? 'unresolved' : 'missing',
    candidates: [],
    reasons: [],
    rejected: [],
    substituted: false,
  };
}

/** Resolve a whole pack. Ordering is preserved: the layers are a sequence. */
export function resolvePack(pack: SkillPack, input: ResolveInput): PackState {
  const entries = pack.entries.map((e) => resolveEntry(e, input));
  const required = entries.filter((e) => e.required);
  const satisfied = required.filter(
    (e) => e.status === 'match' || e.status === 'substituted',
  );
  return {
    id: pack.id,
    title: pack.title,
    required: required.length,
    satisfied: satisfied.length,
    ready: satisfied.length === required.length,
    entries,
  };
}

export function resolveAllPacks(input: ResolveInput): PackState[] {
  return DEFAULT_PACKS.map((p) => resolvePack(p, input));
}

/**
 * Installed skills that would satisfy a slot.
 *
 * This is what the substitution picker offers, and the reason it is computed
 * rather than listed is that it must agree with the checker. A picker that
 * offered a skill the checker then rejected would be a worse experience than no
 * picker at all.
 *
 * `exclude` is the skills already filling another slot of the same pack. Without
 * it, `hig-foundations` was offered as a substitute for *interaction
 * engineering* — it genuinely discusses motion, and it outscored the intended
 * `frontend-design` for visual direction. A foundations skill is not an
 * interaction engineer, and the five layers exist precisely because those are
 * different jobs; letting one skill answer three of them turns the stack back
 * into the single vague "design skill" it was split out of.
 */
export function substitutionCandidates(
  packId: string,
  slot: string,
  installed: ReadonlyMap<string, string>,
  exclude: ReadonlySet<string> = new Set(),
): SkillVerification[] {
  const entry = entryBySlot(packId, slot);
  if (entry === null) return [];
  const out: SkillVerification[] = [];
  for (const [id, raw] of installed) {
    if (exclude.has(id)) continue;
    const verdict = verifySkill(id, raw, entry.contract);
    if (verdict.status === 'match') out.push(verdict);
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** The skills a pack is currently using for its *other* slots. */
export function boundElsewhere(
  entries: readonly SlotState[],
  exceptSlot: string,
): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.slot === exceptSlot) continue;
    if (e.skill !== null) out.add(e.skill);
  }
  return out;
}
