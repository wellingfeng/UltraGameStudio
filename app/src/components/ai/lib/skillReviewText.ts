// Localize host diagnostics at display time so persisted and remote results work
// without changing the approval payload, evidence or exact file diffs.
const chineseReasons = new Map<string, string>([
  ['description first 57 characters do not declare a clear trigger', '描述的前 57 个字符未明确说明触发条件'],
  ['lesson has no trusted verification or explicit user correction', '该经验缺少可信验证或用户明确纠正'],
  ['patch removes/replaces an existing rule; explicit review required', '修改会删除或替换已有规则，需要明确批准'],
  ['trigger scope/frontmatter change requires approval', '触发范围或技能元数据发生变化，需要批准'],
  ['whole-file rewrite requires approval', '整份文件重写需要批准'],
  ['whole-file rewriting requires approval', '整份文件重写需要批准'],
  ['support file removal requires approval', '删除辅助文件需要批准'],
  ['file removal requires approval', '删除文件需要批准'],
  ['handwritten/imported skill has no automatic edit authorization', '手写或导入的技能尚未授权自动修改'],
  ['target has not been authorized for automatic editing', '目标技能尚未授权自动修改'],
  ['contentLocked requires explicit approval', '技能内容已锁定，需要明确批准'],
  ['target content is locked', '目标技能内容已锁定'],
  ['scripts/templates/assets require approval', '脚本、模板或资源修改需要批准'],
  ['scripts/templates/assets and non-markdown references require approval', '脚本、模板、资源或非 Markdown 参考文件修改需要批准'],
  ['global promotion requires approval', '推广为全局技能需要批准'],
  ['approve-all host policy', '当前策略要求所有修改经用户批准'],
  ['all changes require approval', '当前策略要求所有修改经用户批准'],
  ['insufficient verified evidence', '缺少充分的已验证证据'],
  ['content safety heuristic flagged execution or instruction/permission override', '内容检查发现命令执行或覆盖指令、权限的风险'],
  ['content may contain secrets or personal credentials; explicit review required', '内容可能含有密钥或个人凭据，需要明确审核'],
  ['No authentic reusable evidence or learning disabled.', '没有可信的可复用证据，或技能学习已关闭。'],
]);

export function localizeSkillReviewText(text: string, chinese: boolean): string {
  if (!chinese) return text;
  const budget = text.match(/^(?:Error:\s*)?SKILL_REVIEW_BUDGET_(TOKENS|TIME|ROUNDS)$/)?.[1];
  if (budget === 'TOKENS') return '复盘输入或输出用量超出预算，未应用修改。原始证据已保留，可重新复盘。';
  if (budget === 'TIME') return '复盘超过配置的时间预算，未应用修改。原始证据已保留，可重新复盘。';
  if (budget === 'ROUNDS') return '复盘达到模型调用轮数上限，未应用修改。原始证据已保留，可重新复盘。';
  return chineseReasons.get(text) ?? text;
}
