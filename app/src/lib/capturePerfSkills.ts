export type CapturePerfSkillCategory =
  | 'gpu-frame'
  | 'gpu-trace'
  | 'engine-trace'
  | 'android-trace'
  | 'android-memory';

export type CapturePerfSkillInstallKind = 'remote-skill' | 'generated-skill';

export interface CapturePerfSkillDefinition {
  id: string;
  slug: string;
  name: string;
  title: string;
  summary: string;
  category: CapturePerfSkillCategory;
  version: string;
  sourceUrl: string;
  installKind: CapturePerfSkillInstallKind;
  skillUrl?: string;
  skillText?: string;
  command?: string;
  tags: string[];
}

function skillText(name: string, description: string, body: readonly string[]): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
    ...body,
    '',
  ].join('\n');
}

const SMART_PERFETTO_SKILL = skillText(
  'smart-perfetto',
  'Analyze Android Perfetto traces with SmartPerfetto and evidence-backed AI workflow guidance.',
  [
    'Use when the user needs Android performance analysis from Perfetto traces, startup traces, frame jank, scheduling, binder, CPU, memory, or scene inventory data.',
    '',
    'Workflow:',
    '1. Verify the trace source and whether SmartPerfetto is already installed or reachable.',
    '2. Prefer the packaged UI or Docker flow from the SmartPerfetto repo. Keep provider credentials in the app UI or environment files, not in chat.',
    '3. Load the trace, ask for evidence-backed analysis, and preserve SQL evidence, time ranges, process/thread names, and suspected root cause.',
    '4. For fixes, separate trace-backed facts from hypotheses and request a new trace after changes.',
    '',
    'Useful source commands:',
    '- git clone https://github.com/Gracker/SmartPerfetto',
    '- docker compose -f docker-compose.hub.yml up -d',
    '- ./start.sh',
  ],
);

const ANDROID_MEMORY_SKILL = skillText(
  'android-app-memory-analysis',
  'Capture and analyze Android app memory evidence with HPROF, smaps, meminfo, gfxinfo, and live ADB dumps.',
  [
    'Use when the user needs Android app memory diagnosis: Java heap, native memory, smaps, PSS, SwapPSS, DMA-BUF, graphics memory, meminfo, gfxinfo, or live dumps.',
    '',
    'Workflow:',
    '1. Check Python 3.8+ and adb availability. Confirm the device is connected and USB debugging is enabled.',
    '2. Prefer live collection when the package is debuggable. Use quick mode when HPROF is too slow or unavailable.',
    '3. Keep raw dumps and generated JSON reports together so later analysis can compare before/after runs.',
    '4. Report memory class, PSS/SwapPSS deltas, largest mappings, allocator evidence, and missing-permission gaps separately.',
    '',
    'Useful source commands:',
    '- git clone https://github.com/Gracker/Android-App-Memory-Analysis',
    '- python3 analyze.py live --list',
    '- python3 analyze.py live --package com.example.app --skip-hprof',
    '- python3 analyze.py panorama -d ./dumps/com.example.app_YYYYMMDD_HHMMSS',
  ],
);

const UNITY_PERFORMANCE_WORKFLOW_SKILL = skillText(
  'unity-performance-workflow',
  'Diagnose Unity runtime performance with profiler captures, frame-time evidence, GC analysis, and rendering/batching checks.',
  [
    'Use when the user needs Unity performance work: low FPS, frame spikes, Play Mode profiling, CPU/GPU frame time, GC allocations, heap pressure, draw calls, batching, or rendering bottlenecks.',
    '',
    'Workflow:',
    '1. Confirm the project opens in Unity and identify the target scene, device/platform, quality level, and repro steps.',
    '2. Prefer existing Unity automation or unity-cli tooling when available. Before running capture commands, inspect the project/tool docs so command names and profiler flags match the installed tool.',
    '3. Enter Play Mode or launch the target build, reproduce the issue, and capture multiple frames around the spike instead of relying on a single frame.',
    '4. Report CPU main-thread cost, render thread/GPU cost, GC allocation spikes, heap growth, draw calls, batches, SetPass calls, and expensive scripts/shaders separately.',
    '5. Keep evidence attached: capture file paths, frame numbers/time ranges, profiler module names, before/after numbers, and unresolved gaps.',
    '6. Recommend fixes by bottleneck class: script scheduling and allocations for CPU/GC, batching/material/shader/overdraw for rendering, asset lifetime/pooling for memory.',
    '',
    'Useful checks:',
    '- Verify Profiler data was captured in Development Build or Editor Play Mode with deep profiling only when needed.',
    '- Compare average frames and spike frames; do not optimize based only on editor overhead.',
    '- Re-capture after fixes with the same scene, camera path, quality level, and hardware.',
  ],
);

export const CAPTURE_PERF_SKILLS: CapturePerfSkillDefinition[] = [
  {
    id: 'renderdoc-gpu-debug',
    slug: 'renderdoc-gpu-debug',
    name: 'renderdoc-gpu-debug',
    title: 'RenderDoc GPU Debug',
    summary: '用 rdc-cli 分析 .rdc、管线状态、渲染目标、pixel history 和 GPU 绘制问题。',
    category: 'gpu-frame',
    version: 'master',
    sourceUrl: 'https://github.com/rudybear/renderdoc-skill',
    installKind: 'remote-skill',
    skillUrl:
      'https://raw.githubusercontent.com/rudybear/renderdoc-skill/master/.claude/skills/renderdoc-gpu-debug/SKILL.md',
    command: 'rdc doctor',
    tags: ['RenderDoc', 'D3D', 'Vulkan', 'OpenGL'],
  },
  {
    id: 'cli-anything-nsight-graphics',
    slug: 'cli-anything-nsight-graphics',
    name: 'cli-anything-nsight-graphics',
    title: 'Nsight Graphics CLI',
    summary: 'Windows 优先的 Nsight Graphics 抓帧、GPU Trace 摘要和 ngfx-replay 分析。',
    category: 'gpu-trace',
    version: '0.2.0',
    sourceUrl:
      'https://github.com/HKUDS/CLI-Anything/blob/main/skills/cli-anything-nsight-graphics/SKILL.md',
    installKind: 'remote-skill',
    skillUrl:
      'https://raw.githubusercontent.com/HKUDS/CLI-Anything/main/skills/cli-anything-nsight-graphics/SKILL.md',
    command: 'pip install cli-anything-nsight-graphics',
    tags: ['Nsight', 'GPU Trace', 'NVIDIA', 'Windows'],
  },
  {
    id: 'cli-anything-renderdoc',
    slug: 'cli-anything-renderdoc',
    name: 'cli-anything-renderdoc',
    title: 'CLI-Anything RenderDoc',
    summary: 'RenderDoc 抓帧分析 CLI harness，适合把帧调试流程暴露给 agent 调用。',
    category: 'gpu-frame',
    version: '0.1.0',
    sourceUrl:
      'https://github.com/HKUDS/CLI-Anything/blob/main/skills/cli-anything-renderdoc/SKILL.md',
    installKind: 'remote-skill',
    skillUrl:
      'https://raw.githubusercontent.com/HKUDS/CLI-Anything/main/skills/cli-anything-renderdoc/SKILL.md',
    command: 'pip install cli-anything-renderdoc',
    tags: ['RenderDoc', 'CLI-Anything', 'GPU'],
  },
  {
    id: 'cli-anything-unrealinsights',
    slug: 'cli-anything-unrealinsights',
    name: 'cli-anything-unrealinsights',
    title: 'Unreal Insights CLI',
    summary: 'Windows 优先的 UE trace 采集、Trace Store 浏览、GUI 打开、timing/counter 导出和摘要。',
    category: 'engine-trace',
    version: 'main',
    sourceUrl:
      'https://github.com/HKUDS/CLI-Anything/blob/main/unrealinsights/agent-harness/cli_anything/unrealinsights/skills/SKILL.md',
    installKind: 'remote-skill',
    skillUrl:
      'https://raw.githubusercontent.com/HKUDS/CLI-Anything/main/unrealinsights/agent-harness/cli_anything/unrealinsights/skills/SKILL.md',
    command: 'cli-anything-unrealinsights --json backend info',
    tags: ['Unreal', 'Trace Store', 'Timing', 'Counters'],
  },
  {
    id: 'unity-performance-workflow',
    slug: 'unity-performance-workflow',
    name: 'unity-performance-workflow',
    title: 'Unity Performance Workflow',
    summary: 'Unity Profiler 性能工作流：CPU/GPU frame time、GC spike、内存、draw call 和 batching 诊断。',
    category: 'engine-trace',
    version: 'mcpmarket',
    sourceUrl: 'https://mcpmarket.com/zh/tools/skills/unity-performance-workflow',
    installKind: 'generated-skill',
    skillText: UNITY_PERFORMANCE_WORKFLOW_SKILL,
    tags: ['Unity', 'Profiler', 'GC', 'Batching'],
  },
  {
    id: 'smart-perfetto',
    slug: 'smart-perfetto',
    name: 'smart-perfetto',
    title: 'SmartPerfetto',
    summary: '面向 Android Perfetto trace 的 AI 分析平台，强调 SQL 证据、根因推理和优化建议。',
    category: 'android-trace',
    version: '1.0.33',
    sourceUrl: 'https://github.com/Gracker/SmartPerfetto',
    installKind: 'generated-skill',
    skillText: SMART_PERFETTO_SKILL,
    command: 'docker compose -f docker-compose.hub.yml up -d',
    tags: ['Perfetto', 'Android', 'Trace', 'AI'],
  },
  {
    id: 'android-app-memory-analysis',
    slug: 'android-app-memory-analysis',
    name: 'android-app-memory-analysis',
    title: 'Android App Memory Analysis',
    summary: 'Android 内存采集和分析：HPROF、smaps、meminfo、gfxinfo、live dump、panorama 报告。',
    category: 'android-memory',
    version: '1.1.0',
    sourceUrl: 'https://github.com/Gracker/Android-App-Memory-Analysis',
    installKind: 'generated-skill',
    skillText: ANDROID_MEMORY_SKILL,
    command: 'python3 analyze.py live --package com.example.app --skip-hprof',
    tags: ['Android', 'Memory', 'HPROF', 'smaps'],
  },
];

export function capturePerfCategoryLabel(category: CapturePerfSkillCategory): string {
  switch (category) {
    case 'gpu-frame':
      return 'GPU 抓帧';
    case 'gpu-trace':
      return 'GPU Trace';
    case 'engine-trace':
      return '引擎 Trace';
    case 'android-trace':
      return 'Android Trace';
    case 'android-memory':
      return 'Android 内存';
  }
}
