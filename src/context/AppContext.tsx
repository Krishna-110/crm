import { createContext, useContext, useEffect, useReducer } from 'react';
import type { ReactNode, Dispatch } from 'react';
import type { AppState, AppAction } from '@/types';
import { authApi } from '@/api/auth';
import { leadsApi } from '@/api/leads';
import { usersApi } from '@/api/users';
import { medicinesApi } from '@/api/medicines';
import { ordersApi } from '@/api/orders';
import { renewalsApi } from '@/api/renewals';
import { followUpsApi } from '@/api/followUps';
import { notificationsApi } from '@/api/notifications';
import { miscApi } from '@/api/misc';
import { getToken, setToken, clearToken } from '@/api/client';

const initialState: AppState = {
  currentUser: null,
  users: [],
  leads: [],
  orders: [],
  renewals: [],
  followUps: [],
  notifications: [],
  medicines: [],
  dashboard: null,
  searchQuery: '',
  booting: true,
};

export async function loadAll(dispatch: Dispatch<AppAction>) {
  const [users, leads, orders, renewals, followUps, notifications, medicines, dashboard] = await Promise.all([
    usersApi.list(),
    leadsApi.list(),
    ordersApi.list(),
    renewalsApi.list(),
    followUpsApi.list(),
    notificationsApi.list(),
    medicinesApi.list(),
    miscApi.dashboard(),
  ]);
  dispatch({
    type: 'HYDRATE',
    payload: { users, leads, orders, renewals, followUps, notifications, medicines, dashboard },
  });
}

export async function login(dispatch: Dispatch<AppAction>, email: string, password: string) {
  const { token, user } = await authApi.login(email, password);
  setToken(token);
  dispatch({ type: 'LOGIN', payload: { user } });
  await loadAll(dispatch);
}

export async function logout(dispatch: Dispatch<AppAction>) {
  try {
    await authApi.logout();
  } catch {
    // best-effort — clear local state regardless of whether the server call succeeded
  }
  clearToken();
  dispatch({ type: 'LOGOUT' });
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'LOGIN':
      return { ...state, currentUser: action.payload.user };

    case 'LOGOUT':
      return { ...initialState, booting: false };

    case 'HYDRATE':
      return { ...state, ...action.payload, booting: false };

    case 'SET_BOOTING':
      return { ...state, booting: action.payload.booting };

    case 'ADD_LEAD':
      return { ...state, leads: [action.payload.lead, ...state.leads] };

    case 'UPDATE_LEAD':
      return {
        ...state,
        leads: state.leads.map((lead) =>
          lead.id === action.payload.id ? { ...lead, ...action.payload.updates } : lead,
        ),
      };

    case 'DELETE_LEAD':
      return {
        ...state,
        leads: state.leads.filter((lead) => lead.id !== action.payload.id),
      };

    case 'ASSIGN_LEAD':
      return {
        ...state,
        leads: state.leads.map((lead) =>
          lead.id === action.payload.leadId
            ? { ...lead, assignedCaller: action.payload.callerId }
            : lead,
        ),
      };

    case 'ADD_USER':
      return { ...state, users: [action.payload.user, ...state.users] };

    case 'UPDATE_USER':
      return {
        ...state,
        users: state.users.map((user) =>
          user.id === action.payload.id ? { ...user, ...action.payload.updates } : user,
        ),
      };

    case 'DELETE_USER':
      return {
        ...state,
        users: state.users.filter((user) => user.id !== action.payload.id),
      };

    case 'ADD_ORDER':
      return { ...state, orders: [action.payload.order, ...state.orders] };

    case 'UPDATE_ORDER':
      return {
        ...state,
        orders: state.orders.map((order) =>
          order.id === action.payload.id ? { ...order, ...action.payload.updates } : order,
        ),
      };

    case 'ADD_RENEWAL':
      return { ...state, renewals: [action.payload.renewal, ...state.renewals] };

    case 'UPDATE_RENEWAL':
      return {
        ...state,
        renewals: state.renewals.map((renewal) =>
          renewal.id === action.payload.id ? { ...renewal, ...action.payload.updates } : renewal,
        ),
      };

    case 'ADD_FOLLOW_UP':
      return { ...state, followUps: [action.payload.followUp, ...state.followUps] };

    case 'UPDATE_FOLLOW_UP':
      return {
        ...state,
        followUps: state.followUps.map((followUp) =>
          followUp.id === action.payload.id
            ? { ...followUp, ...action.payload.updates }
            : followUp,
        ),
      };

    case 'ADD_NOTIFICATION':
      return {
        ...state,
        notifications: [action.payload.notification, ...state.notifications],
      };

    case 'MARK_NOTIFICATION_READ':
      return {
        ...state,
        notifications: state.notifications.map((notification) =>
          notification.id === action.payload.id
            ? { ...notification, read: true }
            : notification,
        ),
      };

    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.payload.query };

    case 'ADD_LEAD_ACTIVITY':
      return {
        ...state,
        leads: state.leads.map((lead) =>
          lead.id === action.payload.leadId
            ? { ...lead, activities: [action.payload.activity, ...(lead.activities || [])] }
            : lead,
        ),
      };

    case 'ADD_MEDICINE':
      return { ...state, medicines: [action.payload.medicine, ...state.medicines] };

    case 'UPDATE_MEDICINE':
      return {
        ...state,
        medicines: state.medicines.map((medicine) =>
          medicine.id === action.payload.id ? { ...medicine, ...action.payload.updates } : medicine,
        ),
      };

    case 'DELETE_MEDICINE':
      return {
        ...state,
        medicines: state.medicines.filter((medicine) => medicine.id !== action.payload.id),
      };

    default:
      return state;
  }
}

const AppContext = createContext<
  { state: AppState; dispatch: React.Dispatch<AppAction> } | undefined
>(undefined);

function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  useEffect(() => {
    async function boot() {
      const token = getToken();
      if (!token) {
        dispatch({ type: 'SET_BOOTING', payload: { booting: false } });
        return;
      }
      try {
        const { user } = await authApi.me();
        dispatch({ type: 'LOGIN', payload: { user } });
        await loadAll(dispatch);
      } catch {
        clearToken();
        dispatch({ type: 'SET_BOOTING', payload: { booting: false } });
      }
    }
    boot();
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}

function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}

export { AppProvider, useApp };
