export type ToastType = 'error' | 'success' | 'info';

export const TOAST_EVENT = 'medcrm:toast';

export type ToastEventDetail = {
  message: string;
  type: ToastType;
};

// A plain window-event bus rather than a React context, so code outside the component
// tree (api/client.ts on a 401, for instance) can raise a toast without needing a hook.
export function emitToast(message: string, type: ToastType = 'error') {
  window.dispatchEvent(new CustomEvent<ToastEventDetail>(TOAST_EVENT, { detail: { message, type } }));
}
