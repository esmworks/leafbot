import { appEventFilter, type Routine } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { AppEvents } from './RoutineDialog';

vi.mock('@/lib/api', () => ({ api: { setWebhookSecret: vi.fn(), routines: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const routine = (over: Partial<Routine> = {}) =>
  ({ id: 'r1', webhookToken: 'tok', webhookSecretSet: false, ...over }) as Routine;

function show(r: Routine, filter: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['routines'], [r]);
  render(
    <QueryClientProvider client={qc}>
      <AppEvents routine={r} filter={filter} onFilter={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('rutinin uygulama olayı seçicisi', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('kendi anahtarını yapan uygulamada anahtarı ister ve kaydeder', async () => {
    vi.mocked(api.setWebhookSecret).mockResolvedValue(routine({ webhookSecretSet: true }));
    show(routine(), appEventFilter('stripe', 'paymentFailed')!);
    expect(screen.getByText('Signing secret from Stripe')).toBeTruthy();
    expect(screen.getByText(/anyone who knows the address/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Paste it here'), { target: { value: ' whsec_abc12345 ' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.setWebhookSecret).toHaveBeenCalledWith('r1', 'whsec_abc12345'));
  });

  it('anahtarı rutinden alan uygulamada kurulum adımını ve kopyalamayı gösterir, anahtar sormaz', () => {
    show(routine(), appEventFilter('gitlab', 'pipelineFailed')!);
    expect(screen.getByText(/Secret token/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'copy the secret' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('Paste it here')).toBeNull();
  });

  it('kayıtlı anahtar, süzgeç değişse de kaldırılabilir', async () => {
    vi.mocked(api.setWebhookSecret).mockResolvedValue(routine());
    show(routine({ webhookSecretSet: true }), 'action=opened');
    expect(screen.getByText("The app's signing secret")).toBeTruthy();
    expect(screen.getByText(/Secret saved\. Only calls/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.setWebhookSecret).toHaveBeenCalledWith('r1', null));
  });
});
