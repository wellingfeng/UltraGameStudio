import { describe, expect, it } from 'vitest';
import { inferToolCodeLanguage } from './toolCode';

describe('inferToolCodeLanguage', () => {
  it('uses json for structured request bodies', () => {
    expect(
      inferToolCodeLanguage(
        { name: 'Bash', status: 'running' },
        'request',
        '{ "command": "npm test" }',
        true,
      ),
    ).toBe('json');
  });

  it('infers read results from the subject file extension', () => {
    expect(
      inferToolCodeLanguage(
        { name: 'Read', subject: 'app/src/components/ai/ToolCard.tsx', status: 'done' },
        'response',
        'export default function ToolCard() {}',
      ),
    ).toBe('typescript');
  });

  it('detects diffs and stack traces by content', () => {
    expect(
      inferToolCodeLanguage(
        { name: 'command_execution', status: 'done' },
        'response',
        '@@ -1 +1\n-old\n+new',
      ),
    ).toBe('diff');
    expect(
      inferToolCodeLanguage(
        { name: 'command_execution', status: 'error' },
        'response',
        'TypeError: bad\n    at main (src/app.ts:1:2)',
      ),
    ).toBe('log');
  });

  it('detects common shell command subjects', () => {
    expect(
      inferToolCodeLanguage(
        { name: 'command_execution', status: 'done' },
        'details',
        'pwsh.exe -Command "npm test"',
      ),
    ).toBe('powershell');
    expect(
      inferToolCodeLanguage(
        { name: 'command_execution', status: 'done' },
        'details',
        'npm run typecheck',
      ),
    ).toBe('bash');
  });
});
