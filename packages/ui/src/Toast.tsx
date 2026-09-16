import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { Button } from './Button';
import { classes } from './utils';

export type ToastTone = 'success' | 'danger' | 'info';

export interface ToastInput {
  readonly title: string;
  readonly message?: string;
  readonly tone?: ToastTone;
}

interface ToastItem extends ToastInput {
  readonly id: string;
}

interface ToastContextValue {
  readonly pushToast: (toast: ToastInput) => string;
  readonly dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<ReadonlyArray<ToastItem>>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: ToastInput) => {
    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 5000);
    return id;
  }, []);

  const value = useMemo(() => ({ dismissToast, pushToast }), [dismissToast, pushToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="idosi-toast-viewport" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={classes('idosi-toast', `idosi-toast--${toast.tone ?? 'info'}`)}
            role={toast.tone === 'danger' ? 'alert' : 'status'}
          >
            <div>
              <strong>{toast.title}</strong>
              {toast.message ? <p>{toast.message}</p> : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Đóng thông báo ${toast.title}`}
              onClick={() => dismissToast(toast.id)}
            >
              ×
            </Button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
