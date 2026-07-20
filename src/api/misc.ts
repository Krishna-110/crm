import { api } from './client';
import type { DashboardStats } from '@/types';

export type LookupItem = { code: string; label: string };

export type Lookups = {
  leadStatuses: LookupItem[];
  leadPriorities: LookupItem[];
  leadSources: LookupItem[];
  orderStages: LookupItem[];
  paymentStatuses: LookupItem[];
  followUpTypes: LookupItem[];
  followUpStatuses: LookupItem[];
};

export type SearchResult = { type: string; id: string; label: string };

export const miscApi = {
  lookups: () => api.get<Lookups>('/lookups'),
  dashboard: () => api.get<DashboardStats>('/dashboard'),
  search: (q: string) => api.get<SearchResult[]>(`/search?q=${encodeURIComponent(q)}`),
};
