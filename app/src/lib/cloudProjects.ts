/** 云端项目已退役。保留历史数据和旧实现，产品不再提供入口或执行。 */
export const CLOUD_PROJECTS_ENABLED = false;

/** 保留路径识别，避免把旧 remote:// 记录当成本地目录。 */
export function isSupportedWorkspacePath(path: string | null | undefined): boolean {
  return CLOUD_PROJECTS_ENABLED || !path?.trim().startsWith('remote://');
}

export function isSupportedProviderId(id: string): boolean {
  return CLOUD_PROJECTS_ENABLED || !id.startsWith('remote-runner:');
}

export function assertCloudProjectsEnabled(): void {
  if (!CLOUD_PROJECTS_ENABLED) throw new Error('云端项目功能已停止支持。');
}
