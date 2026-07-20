import { api } from './client';
import type { Medicine } from '@/types';

export const medicinesApi = {
  list: () => api.get<Medicine[]>('/medicines'),
  create: (data: Partial<Medicine>) => api.post<Medicine>('/medicines', data),
  update: (id: string, updates: Partial<Medicine>) => api.patch<Medicine>(`/medicines/${id}`, updates),
  remove: (id: string) => api.delete<void>(`/medicines/${id}`),
};
