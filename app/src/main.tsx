import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageBroken } from '@/components/PageBroken';
import { TooltipProvider } from '@/components/ui/tooltip';
import { desktop } from '@/lib/desktop';
import { pageMark } from '@/lib/launchMarks';
import '@/lib/zoom';
import { App } from './App';
import './index.css';

// Turns on the `frameless:` styles and the window drag areas.
if (desktop?.framelessTitleBar) document.documentElement.classList.add('frameless');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        {/* A part that fails to draw shows a way back instead of an empty window. */}
        <ErrorBoundary fallback={<PageBroken />}>
          <App />
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
// The frame after the first render is the first screen the person sees.
requestAnimationFrame(() => requestAnimationFrame(() => pageMark('first-paint')));
