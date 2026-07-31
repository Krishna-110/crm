import { api } from './client';
import type { User } from '@/types';

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ token: string; user: User }>('/auth/login', { email, password }),
  logout: () => api.post<void>('/auth/logout'),
  me: () => api.get<{ user: User }>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    api.patch<void>('/auth/password', { currentPassword, newPassword }),
};
