import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Wiring evidence only; filesystem permissions and persistence are exercised
// separately by the Rust host tests, not inferred from this source check.
const source = readFileSync(resolve('src-tauri/src/lib.rs'), 'utf8');
const history = readFileSync(resolve('src-tauri/src/history.rs'), 'utf8');
const handlers = source.slice(source.indexOf('.invoke_handler(tauri::generate_handler!['));

describe('production native learning command registry', () => {
  it.each(['memory_read_json', 'memory_compare_exchange_json'])('registers the exact %s transaction boundary', command => {
    expect(handlers).toContain(`history::${command},`);
  });
  it('routes candidate CAS through app-origin validation and the source-verifying host', () => {
    expect(source).toMatch(/mod skill_candidates;/);
    const command = source.match(/async fn skill_candidates_request\([\s\S]*?\r?\n}\r?\n/);
    expect(command?.[0]).toContain('require_skill_app(&window)?');
    expect(command?.[0]).toContain('.candidate_request(');
    expect(handlers).toContain('skill_candidates_request,');
  });
  it.each(['memory_read_json', 'memory_compare_exchange_json'])('validates the local app caller for %s', command => {
    const body = history.match(new RegExp(`pub async fn ${command}\\([\\s\\S]*?\\r?\\n}\\r?\\n`));
    expect(body?.[0]).toContain('crate::require_skill_app(&window)?');
  });
});
