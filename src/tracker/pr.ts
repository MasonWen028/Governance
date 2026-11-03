import type { GitSettings } from '../config/settings.js';
import type { ChangeRecord } from './journal.js';
import type { Dossier } from './dossier.js';

/**
 * Composing the integration artifact: the branch name and the pull-request body.
 *
 * Generated from the **record**, never written by the agent that did the work.
 * That is the whole reason this module exists: asking the author to summarise
 * its own output produces a summary nobody can check against anything, and it
 * quietly becomes the second source of truth. Every line below traces to a file,
 * a ticket, a decision, or a run record — so a reviewer reading the PR body is
 * reading the feature's own evidence, in the order it happened.
 *
 * Nothing here touches git. The branch name is computed, not created, and the
 * body is returned, not pushed: moving someone's working tree is a decision this
 * module does not get to make on their behalf.
 */

export interface BranchContext {
  /** The project name — the repository directory, not the workspace path. */
  readonly project: string;
  readonly feature: string;
  /** Optional: the ticket this work lands under. */
  readonly ticket?: string | null;
  /** Optional: the change request that produced this work. */
  readonly change?: string | null;
}

/**
 * A git ref that cannot be rejected.
 *
 * The rules are `git check-ref-format`'s, applied here rather than discovered by
 * a failed `push`: a space, a `..`, or a trailing `.lock` in a template someone
 * typed as free text is otherwise guaranteed to surface at the worst possible
 * moment.
 */
function sanitiseRef(ref: string): string {
  const parts = ref
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .split('/')
    .map((p) => p.replace(/^[.-]+/, '').replace(/\.lock$/, '').replace(/-+$/, ''))
    .filter((p) => p.length > 0);
  return parts.join('/');
}

/**
 * Resolve a branch template against one feature.
 *
 * Supported placeholders: `{project}`, `{feature}`, `{slug}` (the feature again,
 * for templates written either way), `{ticket}`, `{change}`.
 *
 * `{ticket}` with no ticket falls back to the feature slug rather than being
 * dropped: `feat/{ticket}` would otherwise produce `feat/`, which is not a valid
 * ref, and a template that resolves to nothing worse than the feature's own name
 * is the safer failure.
 */
export function branchName(template: string, ctx: BranchContext): string {
  const fallbackFeature = ctx.feature;
  const filled = template.replace(/\{(\w+)\}/g, (_all, key: string) => {
    switch (key) {
      case 'project': return ctx.project;
      // `effort` is the pre-rename spelling; a template saved in settings last
      // week still names it, and a branch name is not worth breaking a link for.
      case 'feature': case 'effort': case 'slug': return ctx.feature;
      case 'ticket': return ctx.ticket ?? fallbackFeature;
      case 'change': return ctx.change ?? fallbackFeature;
      default: return key; // an unknown placeholder stays visible rather than vanishing
    }
  });
  const clean = sanitiseRef(filled);
  return clean.length > 0 ? clean : sanitiseRef(`${ctx.feature}`);
}

export interface ComposeInput {
  readonly dossier: Dossier;
  readonly project: string;
  readonly feature: string;
  readonly git: Pick<GitSettings, 'branchTemplate' | 'integrationTemplate' | 'draftPr'>;
  /**
   * The change this feature was derived from, when there is one. Its own journal
   * holds it, but the PR is where a reviewer meets the reason for the work.
   */
  readonly derivedFrom?: { readonly parent: string; readonly change: string; readonly text: string } | null;
}

export interface PullRequest {
  readonly title: string;
  readonly branch: string;
  readonly base: string;
  readonly draft: boolean;
  readonly body: string;
}

/** One change, in the words the record keeps for it. */
function changeLine(c: ChangeRecord): string {
  const verdict = c.verdict;
  if (verdict === null) {
    return `\`${c.id}\` — ${c.text.trim()}`;
  }
  return `\`${c.id}\` — ${c.text.trim()} _(${verdict.kind}, ${verdict.path}: ${verdict.why})_`;
}

function firstSentence(text: string, upTo = 90): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  const cut = Math.min(flat.length, upTo);
  return flat.length > upTo ? `${flat.slice(0, cut).replace(/[\s,;:.]+$/, '')}…` : flat.slice(0, cut);
}

export function composePullRequest(input: ComposeInput): PullRequest {
  const d = input.dossier;
  const derived = input.derivedFrom ?? null;

  /* The template is the operator's, so a `{ticket}` in it is honoured — but only
   * when exactly one ticket exists. With several, naming one of them would imply
   * that this branch carries that ticket rather than the feature, and picking the
   * unresolved one would change the branch every time a ticket closes. */
  const ticketId = d.tickets.length === 1 ? (d.tickets[0]?.id ?? null) : null;
  const branch = branchName(input.git.branchTemplate, {
    project: input.project,
    feature: input.feature,
    ticket: ticketId,
    change: derived?.change ?? (d.changes[0]?.id ?? null),
  });
  const base = branchName(input.git.integrationTemplate, {
    project: input.project,
    feature: input.feature,
  });

  const lines: string[] = [];

  // What it is. The destination, because that is what the feature said it would
  // deliver when scope was fixed at intake — not what the last run happened to do.
  if (d.destination !== null && d.destination.trim().length > 0) {
    lines.push(`## What this delivers`, '', firstSentence(d.destination, 400), '');
  } else {
    lines.push(`## What this delivers`, '', '_No destination was recorded for this feature._', '');
  }

  /* Why it exists. For a derived feature the reason is the change and its routing:
   * a reviewer who does not know which requirement moved is reviewing blind. */
  const reasons: string[] = [];
  if (derived !== null) {
    reasons.push(
      `Change \`${derived.change}\` filed against \`${derived.parent}\`: “${derived.text.trim()}”`,
    );
  }
  for (const c of d.changes) reasons.push(changeLine(c));
  if (reasons.length > 0) {
    lines.push('## Why', '', ...reasons.map((r) => `- ${r}`), '');
  }

  const resolved = d.tickets.filter((t) => t.status === 'resolved');
  const remaining = d.tickets.filter((t) => t.status !== 'resolved');
  if (resolved.length > 0) {
    lines.push('## What landed', '');
    for (const t of resolved) lines.push(`- \`${t.id}\` — ${firstSentence(t.what, 140)}`);
    lines.push('');
  }
  if (remaining.length > 0) {
    lines.push(
      '## Still open',
      '',
      ...remaining.map((t) => `- \`${t.id}\` (${t.status}) — ${firstSentence(t.what, 140)}`),
      '',
    );
  }

  /* Decisions, so the reviewer can see what a human already signed off and what
   * they are being asked to accept. */
  const decisions = d.gates.flatMap((g) =>
    g.decisions.map((dec) => ({
      gate: `${g.id} (${g.title})`,
      line: `- **${g.id}** ${dec.outcome} by \`${dec.actor}\`${dec.methods.length > 0 ? ` · ${dec.methods.join(', ')}` : ''}${dec.note ? ` — ${dec.note}` : ''}`,
    })),
  );
  if (decisions.length > 0) {
    lines.push('## Gate decisions', '', ...decisions.map((x) => x.line), '');
  }

  if (d.adrs.length > 0) {
    lines.push(
      '## Architecture decisions',
      '',
      ...d.adrs.map((a) => `- \`${a.file}\` — ${a.title}`),
      '',
    );
  }

  if (d.runs.length > 0) {
    lines.push('## Runs', '');
    lines.push('| stage | skill | result | ms |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of d.runs.slice(-12)) {
      lines.push(`| ${r.stage} | ${r.skill ?? '—'} | ${r.status} | ${r.ms ?? '—'} |`);
    }
    lines.push('');
  }

  const records = [
    d.spec.exists ? `\`${d.spec.path}\`` : null,
    d.glossary.exists ? `\`${d.glossary.path}\`` : null,
    d.review.exists ? `\`${d.review.path}\`` : null,
    d.release.exists ? `\`${d.release.path}\`` : null,
    d.retro.exists ? `\`${d.retro.path}\`` : null,
  ].filter((x): x is string => x !== null);
  lines.push(
    '## Records',
    '',
    records.length > 0 ? records.join(' · ') : '_No stage records on disk._',
    '',
  );

  const open = d.changes.filter((c) => c.status === 'open');
  if (open.length > 0) {
    lines.push(
      '## Not done',
      '',
      `> ${open.length} change request(s) are still open on this feature. Shipping with an ` +
        'open requirement change means the grilling disagreed with the spec — resolve them, ' +
        'or route them out, before merging.',
      '',
    );
  }
  if (d.warnings.length > 0) {
    lines.push('## Warnings the scanner raised', '', ...d.warnings.map((w) => `- ${w}`), '');
  }

  lines.push(
    '---',
    '',
    '_Composed from the feature record by the governance control plane. Every line above ' +
      'traces to a file, a ticket, a gate decision or a run._',
  );

  const title = derived !== null
    ? `${derived.change}: ${firstSentence(derived.text, 62)}`
    : d.destination !== null && d.destination.trim().length > 0
      ? firstSentence(d.destination, 68)
      : input.feature;

  return {
    title,
    branch,
    base,
    draft: input.git.draftPr === true,
    body: lines.join('\n'),
  };
}
