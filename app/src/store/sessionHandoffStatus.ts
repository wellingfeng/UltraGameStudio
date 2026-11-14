import { create } from 'zustand';

interface HandoffStatus {
  kind: 'busy' | 'done' | 'error';
  text: string;
}

interface SessionHandoffStatusState {
  bySession: Record<string, HandoffStatus | undefined>;
}

export const useSessionHandoffStatus = create<SessionHandoffStatusState>(() => ({ bySession: {} }));

export function beginSessionHandoff(key: string, text: string): boolean {
  if (useSessionHandoffStatus.getState().bySession[key]?.kind === 'busy') return false;
  useSessionHandoffStatus.setState((state) => ({
    bySession: { ...state.bySession, [key]: { kind: 'busy', text } },
  }));
  return true;
}

export function finishSessionHandoff(key: string, status: HandoffStatus & { kind: 'done' | 'error' }): void {
  useSessionHandoffStatus.setState((state) => ({ bySession: { ...state.bySession, [key]: status } }));
  setTimeout(() => {
    useSessionHandoffStatus.setState((state) => {
      if (state.bySession[key] !== status) return state;
      const bySession = { ...state.bySession };
      delete bySession[key];
      return { bySession };
    });
  }, 4000);
}
