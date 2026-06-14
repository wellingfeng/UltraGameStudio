import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceIdentityPath,
  workspaceIdentityHashInput,
  workspaceLeafName,
} from './paths';

describe('workspace path identity', () => {
  it('preserves POSIX absolute paths', () => {
    expect(normalizeWorkspaceIdentityPath('/Users/fengwei/Project/')).toBe(
      '/Users/fengwei/Project',
    );
    expect(workspaceLeafName('/Users/fengwei/Project/')).toBe('Project');
  });

  it('keeps POSIX identity case-sensitive', () => {
    expect(workspaceIdentityHashInput('/Users/fengwei/Project')).toBe(
      '/Users/fengwei/Project',
    );
    expect(workspaceIdentityHashInput('/Users/fengwei/project')).toBe(
      '/Users/fengwei/project',
    );
  });

  it('normalizes Windows paths case-insensitively', () => {
    expect(normalizeWorkspaceIdentityPath('e:/Game/Client/')).toBe(
      'E:\\Game\\Client',
    );
    expect(workspaceIdentityHashInput('E:\\Game\\Client')).toBe(
      'e:\\game\\client',
    );
    expect(workspaceLeafName('E:\\Game\\Client')).toBe('Client');
  });

  it('preserves UNC share identity', () => {
    expect(normalizeWorkspaceIdentityPath('\\\\server\\share\\Repo')).toBe(
      '\\\\server\\share\\Repo',
    );
    expect(workspaceLeafName('\\\\server\\share\\')).toBe('share');
  });

  it('passes opaque scheme paths (remote://) through verbatim', () => {
    // remote workspaces use a synthetic scheme, not a filesystem path; the
    // scheme separator must survive identity + leaf-name normalization.
    expect(normalizeWorkspaceIdentityPath('remote://rw_abc123')).toBe(
      'remote://rw_abc123',
    );
    expect(workspaceIdentityHashInput('remote://rw_abc123')).toBe(
      'remote://rw_abc123',
    );
    expect(workspaceLeafName('remote://rw_abc123')).toBe('remote://rw_abc123');
  });
});
