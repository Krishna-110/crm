import { api } from './client';
import type { Lead, LeadActivity, Order, FollowUp } from '@/types';

export const leadsApi = {
  list: () => api.get<Lead[]>('/leads'),
  create: (data: Partial<Lead>) => api.post<Lead>('/leads', data),
  update: (id: string, updates: Partial<Lead>) => api.patch<Lead>(`/leads/${id}`, updates),
  remove: (id: string) => api.delete<void>(`/leads/${id}`),
  addActivity: (id: string, description: string) =>
    api.post<LeadActivity>(`/leads/${id}/activities`, { description }),
  convert: (id: string, unitPrice?: number) =>
    api.post<{ order: Order; lead: Lead }>(`/leads/${id}/convert`, { unitPrice }),
  scheduleFollowUp: (id: string, data: { scheduledDate: string; type?: string; notes?: string }) =>
    api.post<{ followUp: FollowUp; lead: Lead }>(`/leads/${id}/follow-ups`, data),
};
