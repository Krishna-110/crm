import { api } from './client';
import type { Notification } from '@/types';

export const notificationsApi = {
  list: () => api.get<Notification[]>('/notifications'),
  markRead: (id: string) => api.patch<Notification>(`/notifications/${id}/read`),
};
