import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { describeChunk, describeEventLine } from '../src/exec/stream.js';

/**
 * Reading an agent's stream out loud.
 *
 * The failure this exists to prevent is a log that is live but unreadable: every
 * step looks the same, nothing says which file or command, and the person
 * watching learns nothing they did not already know. The other failure is a log
 * that is tidy but invented — a target filled in from what the tool usually
 * does rather than from what it was given.
 */

const ev = (type: string, part: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp: 1, sessionID: 's', part });

test('a tool use says which tool and what it was pointed at', () => {
  const line = ev('tool_use', {
    tool: 'read',
    state: { input: { filePath: '.scratch/enquiry/spec.md' } },
  });
  assert.equal(describeEventLine(line), 'read → .scratch/enquiry/spec.md');
});

test('a tool with no target says the tool and nothing else', () => {
  /* Inventing a target would put a file name on screen the agent never named,
   * and a log that lies about what was read is worse than a log that is quiet. */
  assert.equal(describeEventLine(ev('tool_use', { tool: 'bash' })), 'using bash');
  assert.equal(
    describeEventLine(ev('tool_use', { tool: 'bash', state: { input: {} } })),
    'using bash',
  );
});

test('a command is named as the target when there is no file', () => {
  const line = ev('tool_use', { tool: 'bash', state: { input: { command: 'npm test' } } });
  assert.equal(describeEventLine(line), 'bash → npm test');
});

test('the agent saying something is shown as what it said', () => {
  const line = ev('text', { text: 'Reading the enquiry feature\nand its spec.' });
  assert.equal(describeEventLine(line), 'Reading the enquiry feature and its spec.');
});

test('a text event with nothing in it is not shown as a blank line', () => {
  /* A blank line in the log is a line that says the agent paused, which it may
   * not have. Silence is the honest rendering of silence. */
  assert.equal(describeEventLine(ev('text', { text: '   \n  ' })), null);
  assert.equal(describeEventLine(ev('text', {})), null);
});

test('step boundaries are dropped rather than shown as lines', () => {
  /* They carry nothing but the fact that a step began or ended. Printing them
   * makes the log longer and says nothing the next line does not already say. */
  assert.equal(describeEventLine(ev('step_start', {})), null);
  assert.equal(describeEventLine(ev('step_finish', {})), null);
});

test('an unknown event says nothing instead of printing its envelope', () => {
  assert.equal(describeEventLine(ev('something_else', { id: 'x' })), null);
  assert.equal(describeEventLine('{"type":123}'), null);
});

test('a line that is not JSON is passed through, because it is already readable', () => {
  /* The plain lines are the ones most worth seeing — a banner, a warning, a
   * stack trace. Dropping them would hide the failure. */
  assert.equal(describeEventLine('[warn] no skills found'), '[warn] no skills found');
  assert.equal(describeEventLine('{"not json'), '{"not json');
});

test('a chunk of several lines yields only the ones worth showing', () => {
  const chunk = [
    ev('step_start', {}),
    ev('tool_use', { tool: 'read', state: { input: { filePath: 'a.md' } } }),
    ev('step_finish', {}),
    ev('text', { text: 'done' }),
    'plain line',
  ].join('\n');
  assert.deepEqual(describeChunk(chunk), ['read → a.md', 'done', 'plain line']);
});

test('an empty or blank chunk yields nothing', () => {
  assert.deepEqual(describeChunk(''), []);
  assert.deepEqual(describeChunk('\n\n  \n'), []);
});
