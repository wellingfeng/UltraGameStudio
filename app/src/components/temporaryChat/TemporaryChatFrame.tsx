import { useEffect, useRef, useState } from 'react';
import { TemporaryChat, handleChatAction } from './chat';
import { observeCurrentSource, type ContextSource } from './context';
import { temporaryChatDocument, TEMPORARY_CHAT_PERMISSIONS, TEMPORARY_CHAT_SANDBOX } from './document';

// The frame and controller live together so hidden file tabs keep their own conversation.
export default function TemporaryChatFrame({ source, title, hidden = false, fileTab = false, followSource = false, updateSource = false }: {
  source?: ContextSource; title: string; hidden?: boolean; fileTab?: boolean; followSource?: boolean; updateSource?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const initialSource = useRef(source);
  const controllerRef = useRef<TemporaryChat | null>(null);
  const [document] = useState(() => temporaryChatDocument({ fileTab }));

  useEffect(() => {
    const controller = new TemporaryChat(state => frame.current?.contentWindow?.postMessage({ scope: 'ugs-temporary-chat', type: 'state', state }, '*'), undefined, initialSource.current);
    controllerRef.current = controller;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      handleChatAction(controller, event.data);
    };
    window.addEventListener('message', receive);
    const stopObserving = followSource ? observeCurrentSource(next => controller.setSource(next)) : undefined;
    void controller.refresh();
    return () => { stopObserving?.(); window.removeEventListener('message', receive); controllerRef.current = null; controller.dispose(); };
  }, [followSource]);

  useEffect(() => {
    if (updateSource) controllerRef.current?.setSource(source);
  }, [updateSource, source?.key]);

  return <iframe ref={frame} title={title} srcDoc={document}
    sandbox={TEMPORARY_CHAT_SANDBOX} allow={TEMPORARY_CHAT_PERMISSIONS} referrerPolicy="no-referrer"
    hidden={hidden} />;
}
