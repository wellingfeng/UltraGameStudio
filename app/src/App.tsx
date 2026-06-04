import { useEffect } from 'react';
import Sidebar from '@/panels/Sidebar';
import AIDock from '@/panels/AIDock';
import ScheduledTaskRunner from '@/components/ScheduledTaskRunner';
import { primeCliRuntime } from '@/lib/cliConfig';
import { useStore } from '@/store/useStore';

/**
 * Top-level chat layout:
 *   left  : Sidebar
 *   center: AIDock full-height chat surface
 *
 * App.tsx is the consumer of all import contracts.
 */
export default function App() {
  const initHistory = useStore((s) => s.initHistory);

  useEffect(() => {
    initHistory();
    void primeCliRuntime();
  }, [initHistory]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-fg">
      <ScheduledTaskRunner />
      <div className="hidden md:block">
        <Sidebar />
      </div>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AIDock layout="chat" />
      </main>
    </div>
  );
}
