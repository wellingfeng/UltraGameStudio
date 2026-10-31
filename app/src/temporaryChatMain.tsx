import { createRoot } from 'react-dom/client';
import NativeTemporaryChat from './components/temporaryChat/NativeTemporaryChat';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

const params = new URLSearchParams(window.location.search);
createRoot(root).render(<NativeTemporaryChat id={params.get('id') ?? ''} number={params.get('number') ?? ''} />);
