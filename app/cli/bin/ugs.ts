#!/usr/bin/env node
/**
 * `ugs` — the UltraGameStudio command-line interface (spec §5.3 / §6.1).
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
import { CLI_HELP_CAPABILITY_MANIFESTS } from '../../src/lib/capabilityCatalog';
import { localizedText } from '../../src/lib/capabilityManifest';
import { STUDIO_ENABLED } from '../../src/lib/featureFlags';
import type { StudioOptions } from '../commands/studio';
import type { StudioTraceOptions } from '../commands/studioTrace';
// [dynamic-only refactor] 静态蓝图子命令已停用；/studio 默认关闭。
// 源码保留在 cli/commands/ 下（已从编译图 exclude），如需恢复取消下列注释即可。
// import { runGen, type GenOptions } from '../commands/gen';
// import { runInit, type InitOptions } from '../commands/init';
// import { runEmit, type EmitOptions } from '../commands/emit';
// import { runParse, type ParseOptions } from '../commands/parse';
// import { runValidate, type ValidateOptions } from '../commands/validate';
// import { runRun, type RunCommandOptions } from '../commands/run';
// import { runList, type ListOptions } from '../commands/list';
// import { runConvert, type ConvertOptions } from '../commands/convert';
// import { runDiff, type DiffOptions } from '../commands/diff';
// import { runInfo, type InfoOptions } from '../commands/info';

declare const __UGS_CLI_VERSION__: string;
const VERSION = typeof __UGS_CLI_VERSION__ !== 'undefined' ? __UGS_CLI_VERSION__ : '0.1.0';

const program = new Command();

function rootHelpDescription(): string {
  const capabilities = CLI_HELP_CAPABILITY_MANIFESTS.map((manifest) => {
    const name = manifest.command.name;
    const detail = localizedText(manifest.command.detail, 'zh-CN');
    const cliCommand = name === '/studio' ? 'ugs studio "<任务>"' : name;
    return `  ${cliCommand.padEnd(30)} ${detail}`;
  });
  return [
    STUDIO_ENABLED
      ? 'UltraGameStudio CLI — 即时生成并执行动态 workflow harness。'
      : 'UltraGameStudio CLI — /studio 动态多智能体编排默认关闭。',
    '',
    ...capabilities,
    ...(STUDIO_ENABLED
      ? ['  ugs studio-trace <run-id>    查看一次 /studio run 的可观测摘要']
      : []),
  ].join('\n');
}

program
  .name('ugs')
  .description(rootHelpDescription())
  .version(VERSION, '--version', 'show version number')
  .option('-c, --config <path>', 'config file path (default ~/.ugs/config.json)')
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
        process.stderr.write(`ugs: ${err.message}\n`);
        process.exitCode = err.exitCode;
      } else {
        process.stderr.write(`ugs: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}

// --- [dynamic-only refactor] 静态蓝图命令已停用（gen/run 及下方 internal 命令）。
// 实现源码保留在 cli/commands/，已从编译图 exclude；恢复时取消注释并恢复顶部 import。
/*
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
*/

program
  .command('skills <action> [skillId]')
  .description('list or fully view host-managed skills; never executes their scripts')
  .option('--cwd <path>', 'trusted workspace path')
  .option('--file <relative-path>', 'support file to view inside the selected skill')
  .action((action: string, skillId: string | undefined, local: import('../commands/skills').SkillsOptions) =>
    dispatch(async () => {
      const { runSkills } = await import('../commands/skills');
      return runSkills(action, skillId, withGlobals(local));
    }),
  );

for (const action of ['learn', 'refine'] as const) {
  program
    .command(`${action} <text>`)
    .description('review explicit user lesson/correction text; unsafe CLI channels remain unavailable')
    .option('--cwd <path>', 'trusted workspace path')
    .option('--review-url <url>', 'explicit completion-only HTTP endpoint; no agent fallback')
    .option('--review-adapter <adapter>', 'independent reviewer adapter (never the foreground CLI default)')
    .option('--review-provider <id>', 'exact existing single-channel reviewer provider id')
    .option('--review-channel <id>', 'exact reviewer channel; rejected by single-channel CLI config')
    .option('--review-model <id>', 'model identifier for the dedicated reviewer')
    .option('--review-transport <type>', 'openai-compatible or anthropic (default openai-compatible)')
    .option('--review-key-env <name>', 'env variable containing the HTTP credential; never pass the key itself')
    .action((text: string, local: import('../commands/skills').SkillLearnOptions) =>
      dispatch(async () => {
        const { runSkillLearn } = await import('../commands/skills');
        const { loadNodeSkillLearningConfig } = await import('../config/providers');
        const options = withGlobals(local);
        if (!options.reviewUrl) options.skillConfig = loadNodeSkillLearningConfig(options.cwd, options.skillConfig,
          local as import('../config/providers').NodeSkillReviewSelectionFlags);
        return runSkillLearn(action, text, options);
      }),
    );
}

if (STUDIO_ENABLED) {
  program
    .command('studio <task>')
    .description('即时生成、即时执行、带任务账本、预算软停和验收门的动态 workflow harness')
    .option('-a, --adapter <adapter>', 'adapter override')
    .option('-m, --model <model>', 'model override (sonnet, opus, haiku, …)')
    .option('-p, --provider <id>', 'provider id (gateway routing)')
    .option('-o, --output <path>', 'write final result JSON to a file')
    .option('--interactive', 'enable terminal interaction')
    .option('--non-interactive', 'auto-skip interaction requests (default)')
    .option('--planner-only', 'only generate and persist harness.json, do not execute it')
    .option('--resume', 'resume from .ugs-run/<run-id>/result.json')
    .option('--from-harness <path>', 'reuse a saved harness.json and skip planning')
    .option('--trace', 'persist streaming events in events.jsonl')
    .option('--concurrency <n>', 'concurrency limit')
    .option('--max-retries <n>', 'max auto-retries per node')
    .option('--max-agent-calls <n>', 'override studio agent-call budget')
    .option('--max-rounds <n>', 'override studio repair-round budget')
    .option('--verify-command <command>', 'run a local verification command after studio; nonzero exit fails the run')
    .option('--auto-verify', 'also auto-run the planner-proposed command objective checks (file checks always run)')
    .option('--timeout <seconds>', 'per-node timeout seconds')
    .option('--cwd <path>', 'working directory')
    .option('--run-id <id>', 'explicit run directory id under .ugs-run/')
    .option('--review-adapter <adapter>', 'independent completion-only reviewer adapter')
    .option('--review-provider <id>', 'exact existing single-channel reviewer provider id')
    .option('--review-channel <id>', 'exact reviewer channel; rejected by single-channel CLI config')
    .option('--review-model <id>', 'concrete model identifier for the independent HTTP reviewer')
    .option('--review-transport <type>', 'explicit openai-compatible or anthropic review protocol')
    .action((task: string, local: StudioOptions) =>
      dispatch(async () => {
        const { runStudio } = await import('../commands/studio');
        return runStudio(task, withGlobals(local));
      }),
    );

  program
    .command('studio-trace <run-id>')
    .description('显示一次 /studio run 的可观测摘要：节点耗时/返工 + 验收门×真值校准')
    .option('--cwd <path>', 'working directory (where .ugs-run/ lives)')
    .action((runId: string, local: StudioTraceOptions) =>
      dispatch(async () => {
        const { runStudioTrace } = await import('../commands/studioTrace');
        return runStudioTrace(runId, withGlobals(local));
      }),
    );
}

// --- Internal commands (hidden from `--help`; kept as reusable steps) ---
// [dynamic-only refactor] 静态蓝图 internal 命令已停用（init/emit/parse/validate/list/convert/diff/info）。
/*
program
  .command('init [name]', { noHelp: true })
  .description('create a minimal IRGraph blueprint')
  .option('-t, --template <name>', 'use a built-in template (blank, agent-pipeline, code-review, parallel-scan)')
  .option('-f, --from <script>', 'reverse-import an existing .js script')
  .option('-o, --output <path>', 'output path (default <name>.ugs.json)')
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
  .option('-p, --preserve-layout <file>', 'reuse layout from an existing .ugs.json')
  .option('--annotate', 'print parse stats to stderr')
  .action((file: string, local: ParseOptions) => dispatch(() => runParse(file, withGlobals(local))));

program
  .command('validate <file>', { noHelp: true })
  .description('validate a blueprint or script')
  .option('-f, --format <format>', 'input format: auto | ugs | js', 'auto')
  .option('--strict', 'strict semantic validation')
  .action((file: string, local: ValidateOptions) => dispatch(() => runValidate(file, withGlobals(local))));

program
  .command('list <resource>', { noHelp: true })
  .description('list adapters | models | templates')
  .option('-a, --adapter <adapter>', 'adapter (for list models)')
  .action((resource: string, local: ListOptions) => dispatch(() => runList(resource, withGlobals(local))));

program
  .command('convert <file>', { noHelp: true })
  .description('convert between ugs / js / yaml')
  .option('--from <format>', 'source format: auto | ugs | js | yaml', 'auto')
  .option('--to <format>', 'target format: ugs | js | yaml', 'ugs')
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
*/

// [dynamic-only refactor] collect 仅供上面已停用的 repeatable 选项使用，一并停用。
// /** commander collector for repeatable options. */
// function collect(value: string, previous: string[]): string[] {
//   return previous.concat([value]);
// }

program.command('tools <action> [query-or-tool-id]')
  .description('查询当前会话工具目录：search / list / inspect / capabilities；会话内自动继承身份')
  .option('--workspace <id-or-path>', '工作区 ID 或已登记路径')
  .option('--session <id>', '会话 ID')
  .option('--agent <id>', 'Agent ID')
  .option('--provider <id>', '渠道账号 ID')
  .option('--channel <id>', '渠道子账号 ID')
  .option('--model <name>', '会话模型')
  .option('--format <format>', 'json / text', 'json')
  .option('--home <path>', 'UGS 数据根目录')
  .option('--limit <count>', '搜索最多返回条目数（1–100）', '20')
  .action((action: string, tool: string | undefined, opts: import('../commands/tools').ToolsOptions) => dispatch(async () => {
    const { runTools } = await import('../commands/tools'); return runTools(action, tool, opts);
  }));

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`ugs: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
