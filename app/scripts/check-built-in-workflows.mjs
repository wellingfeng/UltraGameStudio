import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(appDir);

const workflowRoot = join(
  appDir,
  'src-tauri',
  'resources',
  'workflows',
  'deep-research',
);

const requiredFiles = [
  'WORKFLOW.md',
  'protocol/model-agnostic-deep-research.md',
  'protocol/README.md',
];

const failures = [];

for (const file of requiredFiles) {
  const path = join(workflowRoot, file);
  if (!existsSync(path)) {
    failures.push(`missing ${relative(root, path)}`);
    continue;
  }
  if (!statSync(path).isFile()) {
    failures.push(`not a file ${relative(root, path)}`);
    continue;
  }
  const text = readFileSync(path, 'utf8');
  if (text.trim().length < 200) {
    failures.push(`too short ${relative(root, path)}`);
  }
}

const workflow = readFileSync(join(workflowRoot, 'WORKFLOW.md'), 'utf8');
for (const needle of [
  'FUC_BUILTIN_DEEP_RESEARCH_WORKFLOW_DIR',
  'protocol/model-agnostic-deep-research.md',
  'not installed in, loaded from, or dependent on a user',
]) {
  if (!workflow.includes(needle)) {
    failures.push(`WORKFLOW.md missing expected text: ${needle}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `Built-in workflow resource check failed:\n${failures.join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write('Built-in workflow resources are complete.\n');
