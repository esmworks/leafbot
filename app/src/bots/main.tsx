import './theme';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageBroken } from '@/components/PageBroken';
import { TooltipProvider } from '@/components/ui/tooltip';
import { desktop } from '@/lib/desktop';
import '@/lib/zoom';
import '../index.css';
import { BotsApp } from './BotsApp';

// In the desktop app's window: the `frameless:` styles and the window drag areas.
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
        <ErrorBoundary fallback={<PageBroken />}>
          <BotsApp />
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
