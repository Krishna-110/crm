import { api } from './client';
import type { Renewal, FollowUp } from '@/types';

export const renewalsApi = {
  list: () => api.get<Renewal[]>('/renewals'),
  renew: (id: string) => api.post<Renewal>(`/renewals/${id}/renew`),
  remind: (id: string, data?: { notes?: string }) => api.post<FollowUp>(`/renewals/${id}/remind`, data),
  cancel: (id: string) => api.delete<void>(`/renewals/${id}`),
};
