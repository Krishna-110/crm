import { api } from './client';
import type { User } from '@/types';

export const usersApi = {
  list: () => api.get<User[]>('/users'),
  create: (data: Partial<User>) => api.post<User>('/users', data),
  update: (id: string, updates: Partial<User>) => api.patch<User>(`/users/${id}`, updates),
  remove: (id: string) => api.delete<void>(`/users/${id}`),
};
