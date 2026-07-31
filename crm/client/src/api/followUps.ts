import { api } from './client';
import type { FollowUp, Lead } from '@/types';

export const followUpsApi = {
  list: () => api.get<FollowUp[]>('/follow-ups'),
  updateStatus: (id: string, status: FollowUp['status']) =>
    api.patch<{ followUp: FollowUp; lead: Lead | null }>(`/follow-ups/${id}`, { status }),
};
