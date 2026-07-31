import { api } from './client';
import type { Lead, LeadActivity, LeadMedicineItem, Order, FollowUp } from '@/types';

export const leadsApi = {
  list: () => api.get<Lead[]>('/leads'),
  create: (data: Partial<Lead>) => api.post<Lead>('/leads', data),
  update: (id: string, updates: Partial<Lead>) => api.patch<Lead>(`/leads/${id}`, updates),
  remove: (id: string) => api.delete<void>(`/leads/${id}`),
  addActivity: (id: string, description: string, medicine?: { name: string; days: number }) =>
    api.post<{ activity: LeadActivity; medicine: LeadMedicineItem | null }>(`/leads/${id}/activities`, {
      description,
      medicine,
    }),
  convert: (id: string, unitPrice?: number) =>
    api.post<{ order: Order; lead: Lead }>(`/leads/${id}/convert`, { unitPrice }),
  scheduleFollowUp: (id: string, data: { scheduledDate: string; type?: string; notes?: string }) =>
    api.post<{ followUp: FollowUp; lead: Lead }>(`/leads/${id}/follow-ups`, data),
};
