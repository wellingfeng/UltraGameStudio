#!/usr/bin/env node
/**
 * `fuc` — the FreeUltraCode command-line interface (spec §5.3 / §6.1).
 *
 * Thin commander dispatcher: parses the global options + subcommand, then hands
 * off to the pure command implementations in cli/commands/*. Every command
 * returns a numeric exit code; CliError carries its own. Credentials are never
 * read here (env-only, handled deep in config/providers + io/cli-spawn).
 *
 * Pure Node entry: imports commander + the command modules only. No react /
 * zustand / tauri.
 */
import { Command } from 'commander';
import { CliError } from '../utils/fs';
import { resolveColor, setColorEnabled, type GlobalOptions } from '../utils/format';
import { runGen, type GenOptions } from '../commands/gen';
import { runInit, type InitOptions } from '../commands/init';
import { runEmit, type EmitOptions } from '../commands/emit';
import { runParse, type ParseOptions } from '../commands/parse';
import { runValidate, type ValidateOptions } from '../commands/validate';
import { runRun, type RunCommandOptions } from '../commands/run';
import { runList, type ListOptions } from '../commands/list';
import { runConvert, type ConvertOptions } from '../commands/convert';
import { runDiff, type DiffOptions } from '../commands/diff';
import { runInfo, type InfoOptions } from '../commands/info';
import { runUltracode, type UltracodeOptions } from '../commands/ultracode';

declare const __FUC_CLI_VERSION__: string;
const VERSION = typeof __FUC_CLI_VERSION__ !== 'undefined' ? __FUC_CLI_VERSION__ : '0.1.0';

const program = new Command();

program
  .name('fuc')
  .description(
    'FreeUltraCode CLI — 用自然语言生成 workflow 脚本，并运行它。\n\n' +
      '  fuc gen "<需求>" -o flow.js     用自然语言生成 workflow（零配置，复用本地 claude 登录态）\n' +
      '  fuc gen flow.js "<修改意图>"     修改已有 workflow 脚本\n' +
      '  fuc run flow.js                 运行 workflow 脚本\n' +
      '  fuc ultracode "<任务>"          即时生成并执行动态 workflow harness',
  )
  .version(VERSION, '--version', 'show version number')
  .option('-c, --config <path>', 'config file path (default ~/.fuc/config.json)')
  .option('-j, --json', 'machine-readable JSON output')
  .option('-v, --verbose', 'verbose (debug) logging')
  .option('-q, --quiet', 'quiet mode (errors only)')
  .option('--no-color', 'disable ANSI colour output');

/** Merge global opts (from the root program) onto a subcommand's local opts. */
function withGlobals<T extends GlobalOptions>(local: T): T {
  const g = program.opts() as GlobalOptions;
  const merged = {
    ...local,
    config: local.config ?? g.config,
    json: local.json ?? g.json,
    verbose: local.verbose ?? g.verbose,
    quiet: local.quiet ?? g.quiet,
    color: g.color,
  } as T;
  setColorEnabled(resolveColor(g.color));
  return merged;
}

/** Wrap a command runner so its numeric exit code / CliError sets process exit. */
function dispatch(fn: () => Promise<number>): void {
  fn()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof CliError) {
        process.stderr.write(`fuc: ${err.message}\n`);
        process.exitCode = err.exitCode;
      } else {
        process.stderr.write(`fuc: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}

// --- User-facing commands (only these two appear in `fuc --help`) ---

program
  .command('gen [request] [output]')
  .description('用自然语言生成或修改 workflow 脚本（零配置，走本地 claude 登录态）')
  .option('-o, --output <path>', '输出脚本路径（生成模式，等价于第二个位置参数）')
  .option('-a, --adapter <adapter>', '适配器（默认 claude-code）')
  .option('-m, --model <model>', '模型档位/ID（haiku | sonnet | opus | …）')
  .option('--cli <path>', '显式指定 CLI 可执行文件路径/名称')
  .action((request: string | undefined, output: string | undefined, local: GenOptions & { cli?: string }) =>
    dispatch(() =>
      runGen(request ?? '', output, {
        ...withGlobals(local),
        cliCommand: local.cli,
      }),
    ),
  );

program
  .command('run <file>')
  .description('运行一个 workflow 脚本')
  .option('-a, --adapter <adapter>', 'adapter override')
  .option('-m, --model <model>', 'model override (sonnet, opus, haiku, …)')
  .option('-p, --provider <id>', 'provider id (gateway routing)')
  .option('--var <key=value>', 'inject a variable (repeatable)', collect, [])
  .option('-o, --output <path>', 'write run result JSON to a file')
  .option('--dry-run', 'emit + validate without spawning agents')
  .option('--interactive', 'enable terminal interaction')
  .option('--non-interactive', 'auto-skip interaction requests (default)')
  .option('--resume', 'resume from the last failed node')
  .option('--concurrency <n>', 'concurrency limit')
  .option('--max-retries <n>', 'max auto-retries per node')
  .option('--timeout <seconds>', 'per-node timeout seconds')
  .option('--cwd <path>', 'working directory')
  .action((file: string, local: RunCommandOptions) => dispatch(() => runRun(file, withGlobals(local))));

program
  .command('ultracode <task>')
  .description('即时生成、即时执行、带任务账本、预算软停和验收门的动态 workflow harness')
  .option('-a, --adapter <adapter>', 'adapter override')
  .option('-m, --model <model>', 'model override (sonnet, opus, haiku, …)')
  .option('-p, --provider <id>', 'provider id (gateway routing)')
  .option('-o, --output <path>', 'write final result JSON to a file')
  .option('--interactive', 'enable terminal interaction')
  .option('--non-interactive', 'auto-skip interaction requests (default)')
  .option('--planner-only', 'only generate and persist harness.json, do not execute it')
  .option('--resume', 'resume from .fuc-run/<run-id>/result.json')
  .option('--from-harness <path>', 'reuse a saved harness.json and skip planning')
  .option('--trace', 'persist streaming events in events.jsonl')
  .option('--concurrency <n>', 'concurrency limit')
  .option('--max-retries <n>', 'max auto-retries per node')
  .option('--max-agent-calls <n>', 'override ultracode agent-call budget')
  .option('--max-rounds <n>', 'override ultracode repair-round budget')
  .option('--verify-command <command>', 'run a local verification command after ultracode; nonzero exit fails the run')
  .option('--timeout <seconds>', 'per-node timeout seconds')
  .option('--cwd <path>', 'working directory')
  .option('--run-id <id>', 'explicit run directory id under .fuc-run/')
  .action((task: string, local: UltracodeOptions) =>
    dispatch(() => runUltracode(task, withGlobals(local))),
  );

// --- Internal commands (hidden from `--help`; kept as reusable steps) ---

program
  .command('init [name]', { noHelp: true })
  .description('create a minimal IRGraph blueprint')
  .option('-t, --template <name>', 'use a built-in template (blank, agent-pipeline, code-review, parallel-scan)')
  .option('-f, --from <script>', 'reverse-import an existing .js script')
  .option('-o, --output <path>', 'output path (default <name>.fuc.json)')
  .option('--stdout', 'write to stdout instead of a file')
  .option('--adapter <adapter>', 'default adapter (default claude-code)')
  .action((name: string | undefined, local: InitOptions) => dispatch(() => runInit(name, withGlobals(local))));

program
  .command('emit <file>', { noHelp: true })
  .description('compile a blueprint into a runnable workflow script')
  .option('-o, --output <path>', 'output path (default stdout)')
  .option('-a, --adapter <adapter>', 'override meta.adapter')
  .option('-s, --schema <name=def>', 'add/override a schema definition (repeatable)', collect, [])
  .option('--format <format>', 'output format: pretty | minified', 'pretty')
  .option('--strip-annotations', 'remove // @node annotations')
  .option('--dry-run', 'verify emit without writing output')
  .action((file: string, local: EmitOptions) => dispatch(() => runEmit(file, withGlobals(local))));

program
  .command('parse <file>', { noHelp: true })
  .description('reverse a .js workflow script into a blueprint')
  .option('-o, --output <path>', 'output path (default stdout)')
  .option('-p, --preserve-layout <file>', 'reuse layout from an existing .fuc.json')
  .option('--annotate', 'print parse stats to stderr')
  .action((file: string, local: ParseOptions) => dispatch(() => runParse(file, withGlobals(local))));

program
  .command('validate <file>', { noHelp: true })
  .description('validate a blueprint or script')
  .option('-f, --format <format>', 'input format: auto | fuc | js', 'auto')
  .option('--strict', 'strict semantic validation')
  .action((file: string, local: ValidateOptions) => dispatch(() => runValidate(file, withGlobals(local))));

program
  .command('list <resource>', { noHelp: true })
  .description('list adapters | models | templates')
  .option('-a, --adapter <adapter>', 'adapter (for list models)')
  .action((resource: string, local: ListOptions) => dispatch(() => runList(resource, withGlobals(local))));

program
  .command('convert <file>', { noHelp: true })
  .description('convert between fuc / js / yaml')
  .option('--from <format>', 'source format: auto | fuc | js | yaml', 'auto')
  .option('--to <format>', 'target format: fuc | js | yaml', 'fuc')
  .option('-o, --output <path>', 'output path (default stdout)')
  .option('--strip-layout', 'drop layout coordinates')
  .option('--strip-run', 'drop the run-state snapshot')
  .action((file: string, local: ConvertOptions) => dispatch(() => runConvert(file, withGlobals(local))));

program
  .command('diff <fileA> <fileB>', { noHelp: true })
  .description('structurally compare two workflows')
  .option('--ignore-layout', 'ignore layout differences')
  .option('--ignore-ids', 'compare structure modulo node ids')
  .action((fileA: string, fileB: string, local: DiffOptions) =>
    dispatch(() => runDiff(fileA, fileB, withGlobals(local))),
  );

program
  .command('info <file>', { noHelp: true })
  .description('show workflow metadata and stats')
  .action((file: string, local: InfoOptions) => dispatch(() => runInfo(file, withGlobals(local))));

/** commander collector for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`fuc: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
