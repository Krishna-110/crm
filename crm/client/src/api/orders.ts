import { api } from './client';
import type { Order } from '@/types';

export const ordersApi = {
  list: () => api.get<Order[]>('/orders'),
  update: (id: string, updates: Partial<Order>) => api.patch<Order>(`/orders/${id}`, updates),
};
