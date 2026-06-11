import type { CliPlatform, ProjectEngineKind } from '@/lib/tauri';

export type ProjectLanguageId =
  | 'cpp'
  | 'csharp'
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'rust'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'dart'
  | 'lua'
  | 'gdscript'
  | 'vue'
  | 'svelte'
  | 'html'
  | 'css'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'markdown'
  | 'shell'
  | 'powershell'
  | 'docker'
  | 'terraform'
  | 'php'
  | 'ruby'
  | 'haskell'
  | 'scala'
  | 'elixir'
  | 'ocaml'
  | 'fsharp'
  | 'julia'
  | 'r'
  | 'nix'
  | 'zig'
  | 'sql'
  | 'graphql'
  | 'prisma'
  | 'solidity'
  | 'shader'
  | 'typst';

export interface ProjectDetectedLanguage {
  id: ProjectLanguageId;
  label: string;
  fileCount: number;
  markerCount: number;
  confidence: number;
  markers: string[];
}

export interface ProjectLanguageScan {
  scannedAtMs: number;
  languages: ProjectDetectedLanguage[];
  filesScanned: number;
  directoriesScanned: number;
  truncated: boolean;
  source: 'workspace' | 'engine-fallback';
  error?: string;
}

export interface LspServerDefinition {
  id: string;
  title: string;
  languageIds: ProjectLanguageId[];
  command: string;
  args: string[];
  install: string;
  installCommands?: LspInstallCommand[];
  description: string;
  sourceUrl: string;
  tags: string[];
  recommendationPriority: number;
  trust: 'official' | 'curated' | 'community';
}

export interface LspInstallCommand {
  label: string;
  command: string;
  args: string[];
  platforms?: CliPlatform[];
}

export interface RankedLspServerDefinition extends LspServerDefinition {
  recommendationScore: number;
  matchedLanguageIds: ProjectLanguageId[];
}

export const PROJECT_LANGUAGE_LABELS: Record<ProjectLanguageId, string> = {
  cpp: 'C / C++',
  csharp: 'C#',
  python: 'Python',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  dart: 'Dart',
  lua: 'Lua',
  gdscript: 'GDScript',
  vue: 'Vue',
  svelte: 'Svelte',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  markdown: 'Markdown',
  shell: 'Shell',
  powershell: 'PowerShell',
  docker: 'Dockerfile',
  terraform: 'Terraform',
  php: 'PHP',
  ruby: 'Ruby',
  haskell: 'Haskell',
  scala: 'Scala',
  elixir: 'Elixir',
  ocaml: 'OCaml',
  fsharp: 'F#',
  julia: 'Julia',
  r: 'R',
  nix: 'Nix',
  zig: 'Zig',
  sql: 'SQL',
  graphql: 'GraphQL',
  prisma: 'Prisma',
  solidity: 'Solidity',
  shader: 'Shader',
  typst: 'Typst',
};

function installCommand(
  label: string,
  command: string,
  args: string[],
  platforms?: CliPlatform[],
): LspInstallCommand {
  return { label, command, args, platforms };
}

function npmGlobal(...packages: string[]): LspInstallCommand[] {
  return [installCommand('npm 全局安装', 'npm', ['install', '-g', ...packages])];
}

function pipInstall(...packages: string[]): LspInstallCommand[] {
  return [installCommand('pip 安装', 'pip', ['install', ...packages])];
}

function cargoInstall(...args: string[]): LspInstallCommand[] {
  return [installCommand('cargo 安装', 'cargo', ['install', ...args])];
}

function dotnetTool(tool: string): LspInstallCommand[] {
  return [installCommand('.NET tool 安装', 'dotnet', ['tool', 'install', '-g', tool])];
}

function goInstall(packageRef: string): LspInstallCommand[] {
  return [installCommand('go install', 'go', ['install', packageRef])];
}

function gemInstall(gem: string): LspInstallCommand[] {
  return [installCommand('gem 安装', 'gem', ['install', gem])];
}

function quoteInstallArg(arg: string): string {
  return /^[\w./:@%#=+-]+$/.test(arg) ? arg : (JSON.stringify(arg) ?? '""');
}

export function installCommandText(command: LspInstallCommand): string {
  return [command.command, ...command.args].map(quoteInstallArg).join(' ');
}

export const LSP_CATALOG: LspServerDefinition[] = [
  {
    id: 'clangd',
    title: 'clangd',
    languageIds: ['cpp'],
    command: 'clangd',
    args: [],
    install: 'LLVM / clang-tools；UE 项目建议生成 compile_commands.json。',
    installCommands: [
      installCommand('winget 安装 LLVM', 'winget', ['install', '--id', 'LLVM.LLVM', '-e'], [
        'windows',
      ]),
      installCommand('Homebrew 安装 LLVM', 'brew', ['install', 'llvm'], ['macos']),
    ],
    description: 'LLVM 官方 C/C++/Objective-C 语言服务器，适合 Unreal Engine 和大型 C++ 项目。',
    sourceUrl: 'https://clangd.llvm.org/',
    tags: ['c', 'cpp', 'c++', 'unreal', 'llvm', 'clang'],
    recommendationPriority: 100,
    trust: 'official',
  },
  {
    id: 'ccls',
    title: 'ccls',
    languageIds: ['cpp'],
    command: 'ccls',
    args: [],
    install: '包管理器安装 ccls；同样依赖编译数据库。',
    description: '高性能 C/C++/Objective-C LSP，适合作为 clangd 替代项。',
    sourceUrl: 'https://github.com/MaskRay/ccls',
    tags: ['c', 'cpp', 'c++', 'clang'],
    recommendationPriority: 72,
    trust: 'community',
  },
  {
    id: 'roslyn-language-server',
    title: 'Roslyn Language Server',
    languageIds: ['csharp'],
    command: 'roslyn-language-server',
    args: [],
    install: 'NuGet / .NET tool 安装对应平台 roslyn-language-server 包。',
    description: 'Roslyn 驱动的 C# LSP，适合现代 .NET / C# 项目。',
    sourceUrl: 'https://www.nuget.org/packages/roslyn-language-server.linux-x64/',
    tags: ['csharp', 'c#', 'dotnet', 'roslyn'],
    recommendationPriority: 94,
    trust: 'official',
  },
  {
    id: 'csharp-ls',
    title: 'csharp-ls',
    languageIds: ['csharp'],
    command: 'csharp-ls',
    args: [],
    install: 'dotnet tool install -g csharp-ls',
    installCommands: dotnetTool('csharp-ls'),
    description: 'Roslyn-based C# LSP，社区维护，安装简单。',
    sourceUrl: 'https://github.com/razzmatazz/csharp-language-server',
    tags: ['csharp', 'c#', 'dotnet', 'roslyn'],
    recommendationPriority: 88,
    trust: 'community',
  },
  {
    id: 'omnisharp-roslyn',
    title: 'OmniSharp',
    languageIds: ['csharp'],
    command: 'omnisharp',
    args: ['--languageserver'],
    install: '下载 OmniSharp Roslyn release，或通过编辑器插件安装。',
    description: '经典 C# / .NET 语言服务，适合旧项目兼容。',
    sourceUrl: 'https://github.com/OmniSharp/omnisharp-roslyn',
    tags: ['csharp', 'c#', 'dotnet', 'omnisharp'],
    recommendationPriority: 68,
    trust: 'community',
  },
  {
    id: 'pyright',
    title: 'Pyright',
    languageIds: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    install: 'npm install -g pyright 或 pip install pyright',
    installCommands: npmGlobal('pyright'),
    description: 'Microsoft Python 类型检查和 LSP，速度快，适合大型 Python 项目。',
    sourceUrl: 'https://github.com/microsoft/pyright',
    tags: ['python', 'pyright', 'typing'],
    recommendationPriority: 100,
    trust: 'official',
  },
  {
    id: 'basedpyright',
    title: 'basedpyright',
    languageIds: ['python'],
    command: 'basedpyright-langserver',
    args: ['--stdio'],
    install: 'pip install basedpyright',
    installCommands: pipInstall('basedpyright'),
    description: 'Pyright fork，增强诊断和配置，适合偏严格的 Python 项目。',
    sourceUrl: 'https://github.com/DetachHead/basedpyright',
    tags: ['python', 'pyright', 'typing'],
    recommendationPriority: 86,
    trust: 'community',
  },
  {
    id: 'pylsp',
    title: 'Python LSP Server',
    languageIds: ['python'],
    command: 'pylsp',
    args: [],
    install: 'pip install python-lsp-server 或 conda install -c conda-forge python-lsp-server',
    installCommands: pipInstall('python-lsp-server'),
    description: 'Python-LSP 生态主线实现，插件多，适合需要 lint/format 插件组合的项目。',
    sourceUrl: 'https://github.com/python-lsp/python-lsp-server',
    tags: ['python', 'pylsp', 'jedi'],
    recommendationPriority: 82,
    trust: 'curated',
  },
  {
    id: 'typescript-language-server',
    title: 'TypeScript Language Server',
    languageIds: ['typescript', 'javascript'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    install: 'npm install -g typescript typescript-language-server',
    installCommands: npmGlobal('typescript', 'typescript-language-server'),
    description: '基于 tsserver 的 TS/JS LSP，适合 Node、React、Vite、前端项目。',
    sourceUrl: 'https://github.com/typescript-language-server/typescript-language-server',
    tags: ['typescript', 'javascript', 'tsserver', 'react', 'vite'],
    recommendationPriority: 100,
    trust: 'community',
  },
  {
    id: 'vtsls',
    title: 'vtsls',
    languageIds: ['typescript', 'javascript'],
    command: 'vtsls',
    args: ['--stdio'],
    install: 'npm install -g @vtsls/language-server',
    installCommands: npmGlobal('@vtsls/language-server'),
    description: 'TypeScript LSP 替代实现，偏 VS Code 行为兼容。',
    sourceUrl: 'https://github.com/yioneko/vtsls',
    tags: ['typescript', 'javascript', 'tsserver'],
    recommendationPriority: 78,
    trust: 'community',
  },
  {
    id: 'eslint-language-server',
    title: 'ESLint Language Server',
    languageIds: ['typescript', 'javascript'],
    command: 'vscode-eslint-language-server',
    args: ['--stdio'],
    install: 'npm install -g vscode-langservers-extracted',
    installCommands: npmGlobal('vscode-langservers-extracted'),
    description: 'ESLint 诊断/修复 LSP，通常与 TypeScript LSP 搭配。',
    sourceUrl: 'https://github.com/microsoft/vscode-eslint',
    tags: ['typescript', 'javascript', 'eslint'],
    recommendationPriority: 74,
    trust: 'official',
  },
  {
    id: 'rust-analyzer',
    title: 'rust-analyzer',
    languageIds: ['rust'],
    command: 'rust-analyzer',
    args: [],
    install: 'rustup component add rust-analyzer',
    installCommands: [installCommand('rustup 组件安装', 'rustup', ['component', 'add', 'rust-analyzer'])],
    description: 'Rust 官方主线 IDE 前端，Cargo 项目默认推荐。',
    sourceUrl: 'https://rust-analyzer.github.io/',
    tags: ['rust', 'cargo'],
    recommendationPriority: 100,
    trust: 'official',
  },
  {
    id: 'gopls',
    title: 'gopls',
    languageIds: ['go'],
    command: 'gopls',
    args: [],
    install: 'go install golang.org/x/tools/gopls@latest',
    installCommands: goInstall('golang.org/x/tools/gopls@latest'),
    description: 'Go 团队官方语言服务器。',
    sourceUrl: 'https://go.dev/gopls/',
    tags: ['go', 'golang'],
    recommendationPriority: 100,
    trust: 'official',
  },
  {
    id: 'jdtls',
    title: 'Eclipse JDT LS',
    languageIds: ['java'],
    command: 'jdtls',
    args: [],
    install: '下载 eclipse.jdt.ls，或通过包管理器安装 jdtls。',
    description: 'Eclipse Java LSP，支持 Maven / Gradle / Java 项目。',
    sourceUrl: 'https://github.com/eclipse-jdtls/eclipse.jdt.ls',
    tags: ['java', 'maven', 'gradle'],
    recommendationPriority: 100,
    trust: 'official',
  },
  {
    id: 'kotlin-language-server',
    title: 'Kotlin Language Server',
    languageIds: ['kotlin'],
    command: 'kotlin-language-server',
    args: [],
    install: '下载 kotlin-language-server release 或通过包管理器安装。',
    description: 'Kotlin LSP，适合 Gradle/Kotlin 项目。',
    sourceUrl: 'https://github.com/fwcd/kotlin-language-server',
    tags: ['kotlin', 'gradle'],
    recommendationPriority: 86,
    trust: 'community',
  },
  {
    id: 'sourcekit-lsp',
    title: 'SourceKit-LSP',
    languageIds: ['swift'],
    command: 'sourcekit-lsp',
    args: [],
    install: '随 Swift toolchain 安装。',
    description: 'Swift 官方 LSP。',
    sourceUrl: 'https://github.com/swiftlang/sourcekit-lsp',
    tags: ['swift', 'sourcekit'],
    recommendationPriority: 100,
    trust: 'official',
  },
  {
    id: 'dart-language-server',
    title: 'Dart Analysis Server',
    languageIds: ['dart'],
    command: 'dart',
    args: ['language-server'],
    install: '安装 Dart / Flutter SDK。',
    description: 'Dart SDK 自带语言服务器入口。',
    sourceUrl: 'https://dart.dev/tools/analysis',
    tags: ['dart', 'flutter'],
    recommendationPriority: 96,
    trust: 'official',
  },
  {
    id: 'lua-language-server',
    title: 'LuaLS',
    languageIds: ['lua'],
    command: 'lua-language-server',
    args: [],
    install: '下载 LuaLS release，或通过包管理器安装。',
    description: 'Lua 语言服务器，适合 Lua / Luau / 游戏脚本项目。',
    sourceUrl: 'https://github.com/LuaLS/lua-language-server',
    tags: ['lua', 'luau'],
    recommendationPriority: 96,
    trust: 'community',
  },
  {
    id: 'gdscript-language-server',
    title: 'Godot GDScript LSP',
    languageIds: ['gdscript'],
    command: 'godot',
    args: ['--headless', '--lsp-port', '6005'],
    install: '安装 Godot；内置 GDScript LSP。',
    description: 'Godot 编辑器内置 GDScript 语言服务器。',
    sourceUrl: 'https://docs.godotengine.org/en/stable/tutorials/editor/external_editor.html',
    tags: ['godot', 'gdscript'],
    recommendationPriority: 92,
    trust: 'official',
  },
  {
    id: 'vue-language-server',
    title: 'Vue Language Server',
    languageIds: ['vue', 'typescript', 'javascript'],
    command: 'vue-language-server',
    args: ['--stdio'],
    install: 'npm install -g @vue/language-server typescript',
    installCommands: npmGlobal('@vue/language-server', 'typescript'),
    description: 'Vue / Volar LSP，适合 Vue SFC 项目。',
    sourceUrl: 'https://github.com/vuejs/language-tools',
    tags: ['vue', 'volar', 'typescript'],
    recommendationPriority: 90,
    trust: 'official',
  },
  {
    id: 'svelte-language-server',
    title: 'Svelte Language Server',
    languageIds: ['svelte', 'typescript', 'javascript'],
    command: 'svelteserver',
    args: ['--stdio'],
    install: 'npm install -g svelte-language-server typescript',
    installCommands: npmGlobal('svelte-language-server', 'typescript'),
    description: 'Svelte / SvelteKit LSP。',
    sourceUrl: 'https://github.com/sveltejs/language-tools',
    tags: ['svelte', 'typescript'],
    recommendationPriority: 90,
    trust: 'official',
  },
  {
    id: 'html-language-server',
    title: 'HTML Language Server',
    languageIds: ['html'],
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    install: 'npm install -g vscode-langservers-extracted',
    installCommands: npmGlobal('vscode-langservers-extracted'),
    description: 'VS Code HTML LSP 抽取版本。',
    sourceUrl: 'https://github.com/hrsh7th/vscode-langservers-extracted',
    tags: ['html', 'web'],
    recommendationPriority: 86,
    trust: 'curated',
  },
  {
    id: 'css-language-server',
    title: 'CSS Language Server',
    languageIds: ['css'],
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    install: 'npm install -g vscode-langservers-extracted',
    installCommands: npmGlobal('vscode-langservers-extracted'),
    description: 'VS Code CSS/SCSS/LESS LSP 抽取版本。',
    sourceUrl: 'https://github.com/hrsh7th/vscode-langservers-extracted',
    tags: ['css', 'scss', 'less', 'web'],
    recommendationPriority: 86,
    trust: 'curated',
  },
  {
    id: 'json-language-server',
    title: 'JSON Language Server',
    languageIds: ['json'],
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    install: 'npm install -g vscode-langservers-extracted',
    installCommands: npmGlobal('vscode-langservers-extracted'),
    description: 'VS Code JSON LSP 抽取版本，适合 package.json / 配置文件。',
    sourceUrl: 'https://github.com/microsoft/vscode/tree/main/extensions/json-language-features/server',
    tags: ['json', 'jsonc', 'config'],
    recommendationPriority: 84,
    trust: 'official',
  },
  {
    id: 'yaml-language-server',
    title: 'YAML Language Server',
    languageIds: ['yaml'],
    command: 'yaml-language-server',
    args: ['--stdio'],
    install: 'npm install -g yaml-language-server',
    installCommands: npmGlobal('yaml-language-server'),
    description: 'Red Hat YAML LSP，支持 schema 校验。',
    sourceUrl: 'https://github.com/redhat-developer/yaml-language-server',
    tags: ['yaml', 'schema', 'kubernetes'],
    recommendationPriority: 88,
    trust: 'community',
  },
  {
    id: 'taplo',
    title: 'Taplo',
    languageIds: ['toml'],
    command: 'taplo',
    args: ['lsp', 'stdio'],
    install: 'cargo install taplo-cli --locked',
    installCommands: cargoInstall('taplo-cli', '--locked'),
    description: 'TOML LSP，适合 Cargo.toml / pyproject.toml 等配置。',
    sourceUrl: 'https://github.com/tamasfe/taplo',
    tags: ['toml', 'cargo', 'config'],
    recommendationPriority: 82,
    trust: 'community',
  },
  {
    id: 'lemminx',
    title: 'LemMinX XML',
    languageIds: ['xml'],
    command: 'lemminx',
    args: [],
    install: '下载 LemMinX release 或通过包管理器安装。',
    description: 'Red Hat XML LSP。',
    sourceUrl: 'https://github.com/eclipse/lemminx',
    tags: ['xml'],
    recommendationPriority: 82,
    trust: 'community',
  },
  {
    id: 'marksman',
    title: 'Marksman',
    languageIds: ['markdown'],
    command: 'marksman',
    args: ['server'],
    install: '下载 Marksman release 或通过包管理器安装。',
    description: 'Markdown LSP，支持 wiki link、标题、引用导航。',
    sourceUrl: 'https://github.com/artempyanykh/marksman',
    tags: ['markdown', 'md'],
    recommendationPriority: 86,
    trust: 'community',
  },
  {
    id: 'bash-language-server',
    title: 'Bash Language Server',
    languageIds: ['shell'],
    command: 'bash-language-server',
    args: ['start'],
    install: 'npm install -g bash-language-server',
    installCommands: npmGlobal('bash-language-server'),
    description: 'Shell/Bash LSP。',
    sourceUrl: 'https://github.com/bash-lsp/bash-language-server',
    tags: ['bash', 'shell', 'sh'],
    recommendationPriority: 86,
    trust: 'community',
  },
  {
    id: 'powershell-editor-services',
    title: 'PowerShell Editor Services',
    languageIds: ['powershell'],
    command: 'pwsh',
    args: ['-NoLogo', '-NoProfile', '-Command', 'Start-EditorServices'],
    install: 'Install-Module PowerShellEditorServices',
    installCommands: [
      installCommand('PowerShell 模块安装', 'pwsh', [
        '-NoLogo',
        '-NoProfile',
        '-Command',
        'Install-Module -Scope CurrentUser -Force PowerShellEditorServices',
      ]),
      installCommand('Windows PowerShell 模块安装', 'powershell', [
        '-NoProfile',
        '-Command',
        'Install-Module -Scope CurrentUser -Force PowerShellEditorServices',
      ], ['windows']),
    ],
    description: 'PowerShell 官方编辑器服务。',
    sourceUrl: 'https://github.com/PowerShell/PowerShellEditorServices',
    tags: ['powershell', 'pwsh'],
    recommendationPriority: 78,
    trust: 'official',
  },
  {
    id: 'dockerfile-language-server',
    title: 'Dockerfile Language Server',
    languageIds: ['docker'],
    command: 'docker-langserver',
    args: ['--stdio'],
    install: 'npm install -g dockerfile-language-server-nodejs',
    installCommands: npmGlobal('dockerfile-language-server-nodejs'),
    description: 'Dockerfile LSP。',
    sourceUrl: 'https://github.com/rcjsuen/dockerfile-language-server-nodejs',
    tags: ['docker', 'dockerfile'],
    recommendationPriority: 86,
    trust: 'community',
  },
  {
    id: 'terraform-ls',
    title: 'terraform-ls',
    languageIds: ['terraform'],
    command: 'terraform-ls',
    args: ['serve'],
    install: '安装 HashiCorp terraform-ls。',
    description: 'HashiCorp 官方 Terraform LSP。',
    sourceUrl: 'https://github.com/hashicorp/terraform-ls',
    tags: ['terraform', 'hcl'],
    recommendationPriority: 96,
    trust: 'official',
  },
  {
    id: 'intelephense',
    title: 'Intelephense',
    languageIds: ['php'],
    command: 'intelephense',
    args: ['--stdio'],
    install: 'npm install -g intelephense',
    installCommands: npmGlobal('intelephense'),
    description: 'PHP LSP，补全和索引能力强。',
    sourceUrl: 'https://intelephense.com/',
    tags: ['php'],
    recommendationPriority: 90,
    trust: 'community',
  },
  {
    id: 'phpactor',
    title: 'Phpactor',
    languageIds: ['php'],
    command: 'phpactor',
    args: ['language-server'],
    install: 'composer global require phpactor/phpactor',
    installCommands: [
      installCommand('Composer 全局安装', 'composer', [
        'global',
        'require',
        'phpactor/phpactor',
      ]),
    ],
    description: 'PHP 重构和 LSP 工具。',
    sourceUrl: 'https://phpactor.readthedocs.io/',
    tags: ['php', 'composer'],
    recommendationPriority: 80,
    trust: 'community',
  },
  {
    id: 'ruby-lsp',
    title: 'Ruby LSP',
    languageIds: ['ruby'],
    command: 'ruby-lsp',
    args: [],
    install: 'gem install ruby-lsp',
    installCommands: gemInstall('ruby-lsp'),
    description: 'Shopify Ruby LSP，适合现代 Ruby/Rails 项目。',
    sourceUrl: 'https://github.com/Shopify/ruby-lsp',
    tags: ['ruby', 'rails'],
    recommendationPriority: 94,
    trust: 'community',
  },
  {
    id: 'solargraph',
    title: 'Solargraph',
    languageIds: ['ruby'],
    command: 'solargraph',
    args: ['stdio'],
    install: 'gem install solargraph',
    installCommands: gemInstall('solargraph'),
    description: 'Ruby LSP 经典实现。',
    sourceUrl: 'https://solargraph.org/',
    tags: ['ruby', 'rails'],
    recommendationPriority: 78,
    trust: 'community',
  },
  {
    id: 'haskell-language-server',
    title: 'Haskell Language Server',
    languageIds: ['haskell'],
    command: 'haskell-language-server-wrapper',
    args: ['--lsp'],
    install: 'ghcup install hls',
    installCommands: [installCommand('GHCup 安装', 'ghcup', ['install', 'hls'])],
    description: 'Haskell 主线 LSP。',
    sourceUrl: 'https://haskell-language-server.readthedocs.io/',
    tags: ['haskell', 'stack', 'cabal'],
    recommendationPriority: 96,
    trust: 'community',
  },
  {
    id: 'metals',
    title: 'Metals',
    languageIds: ['scala'],
    command: 'metals',
    args: [],
    install: 'Coursier 安装 Metals。',
    installCommands: [
      installCommand('Coursier 安装', 'cs', ['install', 'metals']),
      installCommand('Coursier 安装', 'coursier', ['install', 'metals']),
    ],
    description: 'Scala 官方推荐 LSP。',
    sourceUrl: 'https://scalameta.org/metals/',
    tags: ['scala', 'sbt'],
    recommendationPriority: 96,
    trust: 'community',
  },
  {
    id: 'elixir-ls',
    title: 'ElixirLS',
    languageIds: ['elixir'],
    command: 'elixir-ls',
    args: [],
    install: '下载 ElixirLS release 或通过编辑器插件安装。',
    description: 'Elixir LSP。',
    sourceUrl: 'https://github.com/elixir-lsp/elixir-ls',
    tags: ['elixir', 'mix'],
    recommendationPriority: 90,
    trust: 'community',
  },
  {
    id: 'ocamllsp',
    title: 'OCaml LSP',
    languageIds: ['ocaml'],
    command: 'ocamllsp',
    args: [],
    install: 'opam install ocaml-lsp-server',
    installCommands: [
      installCommand('opam 安装', 'opam', ['install', 'ocaml-lsp-server']),
    ],
    description: 'OCaml / Reason 主线 LSP。',
    sourceUrl: 'https://github.com/ocaml/ocaml-lsp',
    tags: ['ocaml', 'reason', 'dune'],
    recommendationPriority: 94,
    trust: 'official',
  },
  {
    id: 'fsautocomplete',
    title: 'FsAutoComplete',
    languageIds: ['fsharp'],
    command: 'fsautocomplete',
    args: ['--adaptive-lsp-server-enabled'],
    install: 'dotnet tool install -g fsautocomplete',
    installCommands: dotnetTool('fsautocomplete'),
    description: 'F# LSP。',
    sourceUrl: 'https://github.com/fsharp/FsAutoComplete',
    tags: ['fsharp', 'f#', 'dotnet'],
    recommendationPriority: 90,
    trust: 'community',
  },
  {
    id: 'julia-language-server',
    title: 'LanguageServer.jl',
    languageIds: ['julia'],
    command: 'julia',
    args: ['--startup-file=no', '--history-file=no', '-e', 'using LanguageServer; runserver()'],
    install: 'julia -e "using Pkg; Pkg.add(\\"LanguageServer\\")"',
    installCommands: [
      installCommand('Julia Pkg 安装', 'julia', [
        '-e',
        'using Pkg; Pkg.add("LanguageServer")',
      ]),
    ],
    description: 'Julia 语言服务器。',
    sourceUrl: 'https://github.com/julia-vscode/LanguageServer.jl',
    tags: ['julia'],
    recommendationPriority: 88,
    trust: 'community',
  },
  {
    id: 'r-languageserver',
    title: 'R languageserver',
    languageIds: ['r'],
    command: 'R',
    args: ['--slave', '-e', 'languageserver::run()'],
    install: 'R -e "install.packages(\\"languageserver\\")"',
    installCommands: [
      installCommand('R install.packages', 'R', [
        '-e',
        'install.packages("languageserver")',
      ]),
    ],
    description: 'R LSP。',
    sourceUrl: 'https://github.com/REditorSupport/languageserver',
    tags: ['r', 'cran'],
    recommendationPriority: 88,
    trust: 'community',
  },
  {
    id: 'nil',
    title: 'nil',
    languageIds: ['nix'],
    command: 'nil',
    args: [],
    install: 'nix profile install nixpkgs#nil',
    installCommands: [
      installCommand('Nix profile 安装', 'nix', ['profile', 'install', 'nixpkgs#nil']),
    ],
    description: 'Nix LSP。',
    sourceUrl: 'https://github.com/oxalica/nil',
    tags: ['nix', 'nixos'],
    recommendationPriority: 90,
    trust: 'community',
  },
  {
    id: 'zls',
    title: 'ZLS',
    languageIds: ['zig'],
    command: 'zls',
    args: [],
    install: '下载 zls release 或 zig build 安装。',
    description: 'Zig 语言服务器。',
    sourceUrl: 'https://github.com/zigtools/zls',
    tags: ['zig'],
    recommendationPriority: 94,
    trust: 'community',
  },
  {
    id: 'sqls',
    title: 'sqls',
    languageIds: ['sql'],
    command: 'sqls',
    args: [],
    install: 'go install github.com/sqls-server/sqls@latest',
    installCommands: goInstall('github.com/sqls-server/sqls@latest'),
    description: 'SQL LSP。',
    sourceUrl: 'https://github.com/sqls-server/sqls',
    tags: ['sql', 'database'],
    recommendationPriority: 78,
    trust: 'community',
  },
  {
    id: 'graphql-language-service',
    title: 'GraphQL LSP',
    languageIds: ['graphql'],
    command: 'graphql-lsp',
    args: ['server', '-m', 'stream'],
    install: 'npm install -g graphql-language-service-cli',
    installCommands: npmGlobal('graphql-language-service-cli'),
    description: 'GraphQL Foundation 语言服务。',
    sourceUrl: 'https://github.com/graphql/graphiql/tree/main/packages/graphql-language-service-cli',
    tags: ['graphql'],
    recommendationPriority: 86,
    trust: 'official',
  },
  {
    id: 'prisma-language-server',
    title: 'Prisma Language Server',
    languageIds: ['prisma'],
    command: 'prisma-language-server',
    args: ['--stdio'],
    install: 'npm install -g @prisma/language-server',
    installCommands: npmGlobal('@prisma/language-server'),
    description: 'Prisma schema LSP。',
    sourceUrl: 'https://github.com/prisma/language-tools',
    tags: ['prisma', 'database'],
    recommendationPriority: 86,
    trust: 'official',
  },
  {
    id: 'solidity-ls',
    title: 'Solidity LS',
    languageIds: ['solidity'],
    command: 'solidity-ls',
    args: ['--stdio'],
    install: 'npm install -g @nomicfoundation/solidity-language-server',
    installCommands: npmGlobal('@nomicfoundation/solidity-language-server'),
    description: 'Solidity LSP。',
    sourceUrl: 'https://github.com/NomicFoundation/hardhat-vscode',
    tags: ['solidity', 'ethereum'],
    recommendationPriority: 80,
    trust: 'community',
  },
  {
    id: 'glsl-analyzer',
    title: 'glsl_analyzer',
    languageIds: ['shader'],
    command: 'glsl_analyzer',
    args: [],
    install: 'cargo install glsl_analyzer',
    installCommands: cargoInstall('glsl_analyzer'),
    description: 'GLSL / shader LSP；Unreal shader 文件可作为候选。',
    sourceUrl: 'https://github.com/nolanderc/glsl_analyzer',
    tags: ['glsl', 'shader', 'hlsl', 'unreal'],
    recommendationPriority: 70,
    trust: 'community',
  },
  {
    id: 'wgsl-analyzer',
    title: 'wgsl-analyzer',
    languageIds: ['shader'],
    command: 'wgsl_analyzer',
    args: [],
    install: 'cargo install --git https://github.com/wgsl-analyzer/wgsl-analyzer wgsl_analyzer',
    installCommands: [
      installCommand('cargo 安装', 'cargo', [
        'install',
        '--git',
        'https://github.com/wgsl-analyzer/wgsl-analyzer',
        'wgsl_analyzer',
      ]),
    ],
    description: 'WGSL 着色器语言服务器，适合 WebGPU / wgpu / Bevy 等项目。',
    sourceUrl: 'https://github.com/wgsl-analyzer/wgsl-analyzer',
    tags: ['wgsl', 'shader', 'webgpu', 'wgpu', 'bevy'],
    recommendationPriority: 66,
    trust: 'community',
  },
  {
    id: 'shader-language-server',
    title: 'Shader Language Server',
    languageIds: ['shader'],
    command: 'shader-language-server',
    args: [],
    install: 'cargo install shader-language-server，或下载对应平台 release。',
    installCommands: cargoInstall('shader-language-server'),
    description: 'HLSL / GLSL / WGSL 着色器 LSP，支持诊断、补全与符号导航。',
    sourceUrl: 'https://github.com/antaalt/shader-language-server',
    tags: ['hlsl', 'glsl', 'wgsl', 'shader', 'unity', 'unreal'],
    recommendationPriority: 64,
    trust: 'community',
  },
  {
    id: 'tinymist',
    title: 'Tinymist',
    languageIds: ['typst'],
    command: 'tinymist',
    args: [],
    install: 'cargo install tinymist',
    installCommands: cargoInstall('tinymist'),
    description: 'Typst LSP。',
    sourceUrl: 'https://github.com/Myriad-Dreamin/tinymist',
    tags: ['typst'],
    recommendationPriority: 84,
    trust: 'community',
  },
  {
    id: 'tailwindcss-language-server',
    title: 'Tailwind CSS Language Server',
    languageIds: ['css', 'html', 'typescript', 'javascript', 'vue', 'svelte'],
    command: 'tailwindcss-language-server',
    args: ['--stdio'],
    install: 'npm install -g @tailwindcss/language-server',
    installCommands: npmGlobal('@tailwindcss/language-server'),
    description: 'Tailwind CSS 智能补全，检测到 Tailwind 配置时优先考虑。',
    sourceUrl: 'https://github.com/tailwindlabs/tailwindcss-intellisense',
    tags: ['tailwind', 'css', 'html', 'typescript'],
    recommendationPriority: 62,
    trust: 'official',
  },
];

const EXTENSION_LANGUAGES: Record<string, ProjectLanguageId[]> = {
  c: ['cpp'],
  cc: ['cpp'],
  cpp: ['cpp'],
  cxx: ['cpp'],
  h: ['cpp'],
  hh: ['cpp'],
  hpp: ['cpp'],
  hxx: ['cpp'],
  ipp: ['cpp'],
  ixx: ['cpp'],
  m: ['cpp'],
  mm: ['cpp'],
  cs: ['csharp'],
  csproj: ['csharp', 'xml'],
  sln: ['csharp'],
  py: ['python'],
  pyw: ['python'],
  pyi: ['python'],
  ts: ['typescript'],
  tsx: ['typescript'],
  mts: ['typescript'],
  cts: ['typescript'],
  js: ['javascript'],
  jsx: ['javascript'],
  mjs: ['javascript'],
  cjs: ['javascript'],
  rs: ['rust'],
  go: ['go'],
  java: ['java'],
  kt: ['kotlin'],
  kts: ['kotlin'],
  swift: ['swift'],
  dart: ['dart'],
  lua: ['lua'],
  luau: ['lua'],
  gd: ['gdscript'],
  vue: ['vue'],
  svelte: ['svelte'],
  html: ['html'],
  htm: ['html'],
  css: ['css'],
  scss: ['css'],
  sass: ['css'],
  less: ['css'],
  json: ['json'],
  jsonc: ['json'],
  yaml: ['yaml'],
  yml: ['yaml'],
  toml: ['toml'],
  xml: ['xml'],
  xaml: ['xml'],
  md: ['markdown'],
  mdx: ['markdown'],
  sh: ['shell'],
  bash: ['shell'],
  zsh: ['shell'],
  fish: ['shell'],
  ps1: ['powershell'],
  psm1: ['powershell'],
  psd1: ['powershell'],
  dockerfile: ['docker'],
  tf: ['terraform'],
  tfvars: ['terraform'],
  hcl: ['terraform'],
  php: ['php'],
  rb: ['ruby'],
  hs: ['haskell'],
  lhs: ['haskell'],
  scala: ['scala'],
  sbt: ['scala'],
  ex: ['elixir'],
  exs: ['elixir'],
  ml: ['ocaml'],
  mli: ['ocaml'],
  fs: ['fsharp'],
  fsx: ['fsharp'],
  jl: ['julia'],
  r: ['r'],
  nix: ['nix'],
  zig: ['zig'],
  sql: ['sql'],
  graphql: ['graphql'],
  gql: ['graphql'],
  prisma: ['prisma'],
  sol: ['solidity'],
  hlsl: ['shader'],
  glsl: ['shader'],
  vert: ['shader'],
  frag: ['shader'],
  comp: ['shader'],
  geom: ['shader'],
  tesc: ['shader'],
  tese: ['shader'],
  usf: ['shader'],
  ush: ['shader'],
  typ: ['typst'],
};

const FILENAME_LANGUAGES: Record<string, ProjectLanguageId[]> = {
  dockerfile: ['docker'],
  'containerfile': ['docker'],
  'docker-compose.yml': ['docker', 'yaml'],
  'docker-compose.yaml': ['docker', 'yaml'],
  'compose.yml': ['docker', 'yaml'],
  'compose.yaml': ['docker', 'yaml'],
  'package.json': ['javascript', 'json'],
  'tsconfig.json': ['typescript', 'json'],
  'jsconfig.json': ['javascript', 'json'],
  'cargo.toml': ['rust', 'toml'],
  'go.mod': ['go'],
  'go.work': ['go'],
  'pyproject.toml': ['python', 'toml'],
  'requirements.txt': ['python'],
  'setup.py': ['python'],
  'pom.xml': ['java', 'xml'],
  'build.gradle': ['java'],
  'build.gradle.kts': ['kotlin'],
  'settings.gradle': ['java'],
  'settings.gradle.kts': ['kotlin'],
  'package.swift': ['swift'],
  'pubspec.yaml': ['dart', 'yaml'],
  'project.godot': ['gdscript'],
  'gemfile': ['ruby'],
  'rakefile': ['ruby'],
  'mix.exs': ['elixir'],
  'dune': ['ocaml'],
  'dune-project': ['ocaml'],
  'project.toml': ['julia', 'toml'],
  'description': ['r'],
  'flake.nix': ['nix'],
  'tailwind.config.js': ['javascript', 'css'],
  'tailwind.config.ts': ['typescript', 'css'],
  'composer.json': ['php', 'json'],
};

export const SKIPPED_LANGUAGE_SCAN_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'bin',
  'obj',
  'library',
  'binaries',
  'intermediate',
  'saved',
  'deriveddatacache',
]);

export function shouldSkipLanguageScanDirectory(name: string): boolean {
  return SKIPPED_LANGUAGE_SCAN_DIRS.has(name.trim().toLowerCase());
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
}

function extensionOf(path: string): string {
  const name = basename(path).toLowerCase();
  if (name.endsWith('.d.ts')) return 'ts';
  if (name.includes('.dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function languageIdsForProjectPath(path: string): ProjectLanguageId[] {
  const name = basename(path).toLowerCase();
  const fromName = FILENAME_LANGUAGES[name] ?? [];
  const fromExt = EXTENSION_LANGUAGES[extensionOf(path)] ?? [];
  return uniq([...fromName, ...fromExt]);
}

function markerForEngine(engine: ProjectEngineKind | 'auto' | undefined): ProjectDetectedLanguage[] {
  if (engine === 'unreal') {
    return [
      {
        id: 'cpp',
        label: PROJECT_LANGUAGE_LABELS.cpp,
        fileCount: 0,
        markerCount: 1,
        confidence: 0.75,
        markers: ['Unreal Engine'],
      },
    ];
  }
  if (engine === 'unity') {
    return [
      {
        id: 'csharp',
        label: PROJECT_LANGUAGE_LABELS.csharp,
        fileCount: 0,
        markerCount: 1,
        confidence: 0.75,
        markers: ['Unity'],
      },
    ];
  }
  if (engine === 'godot') {
    return [
      {
        id: 'gdscript',
        label: PROJECT_LANGUAGE_LABELS.gdscript,
        fileCount: 0,
        markerCount: 1,
        confidence: 0.72,
        markers: ['Godot'],
      },
    ];
  }
  return [];
}

export function detectProjectLanguagesFromPaths(
  paths: string[],
  engine?: ProjectEngineKind | 'auto',
): ProjectDetectedLanguage[] {
  const byId = new Map<
    ProjectLanguageId,
    { fileCount: number; markerCount: number; markers: string[] }
  >();

  const bump = (id: ProjectLanguageId, marker?: string) => {
    const current = byId.get(id) ?? { fileCount: 0, markerCount: 0, markers: [] };
    if (marker) {
      current.markerCount += 1;
      if (!current.markers.includes(marker)) current.markers.push(marker);
    } else {
      current.fileCount += 1;
    }
    byId.set(id, current);
  };

  for (const path of paths) {
    for (const id of languageIdsForProjectPath(path)) bump(id);
  }

  for (const hint of markerForEngine(engine)) {
    const current = byId.get(hint.id) ?? {
      fileCount: 0,
      markerCount: 0,
      markers: [],
    };
    current.markerCount += hint.markerCount;
    current.markers = uniq([...current.markers, ...hint.markers]);
    byId.set(hint.id, current);
  }

  return Array.from(byId.entries())
    .map(([id, item]) => ({
      id,
      label: PROJECT_LANGUAGE_LABELS[id],
      fileCount: item.fileCount,
      markerCount: item.markerCount,
      confidence: Math.min(0.99, 0.35 + item.fileCount * 0.08 + item.markerCount * 0.35),
      markers: item.markers.slice(0, 4),
    }))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.fileCount - a.fileCount ||
        a.label.localeCompare(b.label, 'zh-CN'),
    );
}

export function fallbackLanguageScanForEngine(
  engine?: ProjectEngineKind | 'auto',
): ProjectLanguageScan {
  return {
    scannedAtMs: Date.now(),
    languages: markerForEngine(engine),
    filesScanned: 0,
    directoriesScanned: 0,
    truncated: false,
    source: 'engine-fallback',
  };
}

function languageWeight(languages: ProjectDetectedLanguage[]): Map<ProjectLanguageId, number> {
  const weights = new Map<ProjectLanguageId, number>();
  for (const lang of languages) {
    weights.set(lang.id, lang.confidence * 100 + Math.min(lang.fileCount, 20));
  }
  return weights;
}

function searchableLspText(server: LspServerDefinition): string {
  return [
    server.id,
    server.title,
    server.description,
    server.command,
    server.install,
    server.trust,
    ...server.tags,
    ...server.languageIds.map((id) => PROJECT_LANGUAGE_LABELS[id]),
  ]
    .join(' ')
    .toLowerCase();
}

export function rankLspServers(
  languages: ProjectDetectedLanguage[],
  query = '',
): RankedLspServerDefinition[] {
  const weights = languageWeight(languages);
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return LSP_CATALOG.map((server) => {
    const matchedLanguageIds = server.languageIds.filter((id) => weights.has(id));
    const bestLanguageWeight = Math.max(
      0,
      ...matchedLanguageIds.map((id) => weights.get(id) ?? 0),
    );
    const recommendationScore =
      matchedLanguageIds.length > 0
        ? Math.round(bestLanguageWeight + server.recommendationPriority)
        : 0;
    return {
      ...server,
      recommendationScore,
      matchedLanguageIds,
    };
  })
    .filter((server) => {
      if (terms.length === 0) return true;
      const haystack = searchableLspText(server);
      return terms.every((term) => haystack.includes(term));
    })
    .sort(
      (a, b) =>
        b.recommendationScore - a.recommendationScore ||
        b.recommendationPriority - a.recommendationPriority ||
        a.title.localeCompare(b.title, 'zh-CN'),
    );
}

export function recommendedLspServerIds(
  languages: ProjectDetectedLanguage[],
): string[] {
  const byLanguage = new Map<ProjectLanguageId, RankedLspServerDefinition[]>();
  for (const server of rankLspServers(languages)) {
    if (server.recommendationScore <= 0) continue;
    for (const id of server.matchedLanguageIds) {
      const list = byLanguage.get(id) ?? [];
      list.push(server);
      byLanguage.set(id, list);
    }
  }

  const ids = new Set<string>();
  for (const [, servers] of byLanguage) {
    servers
      .filter((server) => server.recommendationPriority >= 80)
      .slice(0, 2)
      .forEach((server) => ids.add(server.id));
  }
  return [...ids];
}

export function lspServerById(id: string): LspServerDefinition | undefined {
  return LSP_CATALOG.find((server) => server.id === id);
}
