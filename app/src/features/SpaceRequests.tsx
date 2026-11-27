import type { SpaceRequest } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ActionCard } from '@/components/ui/action-card';
import { personNameOf } from '@/features/PeopleTab';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useGroups, useManagesServer, usePeople } from '@/lib/queries';

/** Those asking to join a closed team space; only those who look after the server answer them. */
export function useSpaceRequests() {
  const manages = useManagesServer();
  return (
    useQuery({ queryKey: ['space-requests'], queryFn: api.spaceRequests, enabled: manages, retry: false })
      .data ?? []
  );
}

/** Who asks and for which space, in words; a space or person gone since reads as "someone". */
export function useSpaceRequestTitle() {
  const t = useT();
  const { data: people = [] } = usePeople();
  const { data: groups = [] } = useGroups();
  return (r: SpaceRequest) =>
    t('spaceRequest.title', {
      name: personNameOf(people, r.userId, t('people.owner'), t('common.someone')),
      space: groups.find((g) => g.id === r.groupId)?.name ?? '',
    });
}

/** A request to join a closed team space, as a card at the bottom right of the app. */
export function SpaceRequestCard({ request, onClose }: { request: SpaceRequest; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const title = useSpaceRequestTitle()(request);
  const answer = useMutation({
    mutationFn: (decision: 'allow' | 'deny') => api.answerSpaceRequest(request.id, decision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['space-requests'] });
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (e) => {
      toast.error((e as Error).message);
      void qc.invalidateQueries({ queryKey: ['space-requests'] });
    },
  });
  return (
    <ActionCard
      role="dialog"
      aria-label={title}
      className="pointer-events-auto"
      title={title}
      description={t('spaceRequest.body')}
      closeLabel={t('actionCard.close')}
      onClose={onClose}
      actionLabel={t('spaceRequest.allow')}
      onAction={() => answer.mutate('allow')}
      secondaryLabel={t('spaceRequest.deny')}
      onSecondary={() => answer.mutate('deny')}
      busy={answer.isPending}
    />
  );
}
