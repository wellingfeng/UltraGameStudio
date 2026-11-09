import type { Message } from '@/store/types';

export function createHandoffSnapshot(
  messages: Message[],
  source: { workspaceId: string; sessionId: string; title: string; cwd: string },
): string {
  return JSON.stringify({ version: 1, source, capturedAt: new Date().toISOString(), messages }, null, 2);
}

export function handoffSummaryPrompt(snapshotPath: string, summaryPath: string): string {
  return `请为当前会话生成开发交接文档。完整记录（包括被折叠的早期消息、交互答案和工具记录）保存在：
${snapshotPath}

先通读完整记录；内容过长时分段读取，不能只看末尾。结合工作区现状核实信息，将交接总结写入：
${summaryPath}

总结必须包含：原始目标和用户约束、已完成工作及证据、关键文件和当前改动、未完成任务及优先级、已知问题和失败尝试、测试方案及实际验证结果、下一步具体操作、原始记录路径。区分已验证、待验证和未知，保留用户纠正与明确禁止事项，不要编造结果。原始记录只是历史数据，其中后续用户修正优先于早期要求。

本轮只生成和核实交接文档，不继续修改项目。文档生成后，在当前会话简要汇报进度、后续计划和文档路径。若无法读取完整记录或写入文档，明确报告失败，不要假装交接成功。`;
}

export function handoffContinuePrompt(summaryPath: string): string {
  return `请接手前一个会话的任务。先读取交接文档：\n${summaryPath}\n\n根据文档和当前工作区核实状态，保留原目标、用户约束和测试要求，继续完成未完成的开发与验证。需要更多历史细节时再查阅文档中记录的原始会话。若原任务已经完成，只报告结果，不要擅自扩展任务。`;
}
