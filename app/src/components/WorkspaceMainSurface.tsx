import { useCallback } from 'react';
import AIDock from '@/panels/AIDock';
import MessagePlatformsPanel from '@/panels/MessagePlatformsPanel';
import ScheduledTasksPanel from '@/panels/ScheduledTasksPanel';
import ArtifactsPanel from '@/panels/DownloadsModal';
import { useStore } from '@/store/useStore';
import { useMainSurface } from './MainSurface';

export default function WorkspaceMainSurface() {
  const locale = useStore((s) => s.locale);
  const assetCenterEnabled = useStore((s) => s.assetCenterEnabled);
  const { surface, setSurface } = useMainSurface();
  const returnToChat = useCallback(() => setSurface('chat'), [setSurface]);
  return <>
    {/* Keep drafts, previews and running turns mounted while viewing platform settings. */}
    <div hidden={surface !== 'chat'} className="h-full min-h-0" data-ugs-chat-surface>
      <AIDock layout="chat" />
    </div>
    {surface === 'message-platforms' && <MessagePlatformsPanel onClose={returnToChat} />}
    {surface === 'scheduled-tasks' && <ScheduledTasksPanel locale={locale} onClose={returnToChat} />}
    {surface === 'artifacts' && assetCenterEnabled && <ArtifactsPanel locale={locale} onClose={returnToChat} />}
  </>;
}
