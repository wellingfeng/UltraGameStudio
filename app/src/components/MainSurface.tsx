import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type Surface = 'chat' | 'message-platforms' | 'scheduled-tasks' | 'artifacts';
const MainSurfaceContext = createContext<{ surface: Surface; setSurface: (surface: Surface) => void }>({
  surface: 'chat', setSurface: () => {},
});
export const useMainSurface = () => useContext(MainSurfaceContext);

export function MainSurfaceProvider({ children, sessionKey = '' }: { children: ReactNode; sessionKey?: string }) {
  const [surface, setSurface] = useState<Surface>('chat');
  useEffect(() => { setSurface('chat'); }, [sessionKey]);
  const value = useMemo(() => ({ surface, setSurface }), [surface]);
  return <MainSurfaceContext.Provider value={value}>{children}</MainSurfaceContext.Provider>;
}

