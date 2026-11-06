import {
  SupplierReconciliationAlertsResponseSchema,
  type SupplierReconciliationAlertsResponse,
} from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { request } from '../lib/api';
import { useSession } from '../lib/auth';
import { useDialogAccessibility } from '../lib/use-dialog-accessibility';
import { Button } from './Button';
import './supplier-reconciliation-notice.css';

export function SupplierReconciliationNotice() {
  const principal = useSession().data?.principal;
  const navigate = useNavigate();
  const storageKey = `idosi-source-alerts:${principal?.accountId}:${principal?.role}`;
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(value)
        ? value.filter((key): key is string => typeof key === 'string')
        : [];
    } catch {
      return [];
    }
  });
  const alerts = useQuery({
    queryKey: ['supplier-reconciliation-alerts', principal?.accountId, principal?.role],
    queryFn: async ({ signal }) =>
      SupplierReconciliationAlertsResponseSchema.parse(
        await request('/supplier-reconciliation/alerts', { signal }),
      ),
    enabled: principal?.role === 'ADMIN' || principal?.role === 'HTKD',
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const data = alerts.data;
  if (
    !data?.totalItems ||
    data.data.every((row) => dismissed.includes(`${row.productId}:${row.revision}`))
  )
    return null;
  const dismiss = () => {
    // Keep only live revisions: a later excess receipt must raise a fresh alert.
    const next = data.data.map((row) => `${row.productId}:${row.revision}`);
    setDismissed(next);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* The live tab still remembers. */
    }
  };
  const review = (product?: SupplierReconciliationAlertsResponse['data'][number]) => {
    dismiss();
    const params = new URLSearchParams({ tab: 'reconcile' });
    if (product) {
      params.set('reconcileProduct', product.productId);
      params.set('search', product.productName);
    }
    navigate(`/supplier-reconciliation?${params}`);
  };
  return <SourceAlertDialog data={data} onReview={review} onClose={dismiss} />;
}

function SourceAlertDialog({
  data,
  onReview,
  onClose,
}: {
  readonly data: SupplierReconciliationAlertsResponse;
  readonly onReview: (product?: SupplierReconciliationAlertsResponse['data'][number]) => void;
  readonly onClose: () => void;
}) {
  const dialogRef = useDialogAccessibility(onClose);
  return (
    <div className="dialog-backdrop supplier-source-alert-backdrop">
      <section
        className="dialog supplier-source-alert"
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="supplier-source-alert-title"
        aria-describedby="supplier-source-alert-description"
        tabIndex={-1}
      >
        <AlertTriangle aria-hidden="true" size={52} />
        <h2 id="supplier-source-alert-title">CẦN ĐỐI CHIẾU TỒN RESHARE NGAY</h2>
        <p id="supplier-source-alert-description">
          <strong>{data.totalItems} mặt hàng đang bị chặn cấp mới.</strong> Hệ thống sẽ chuyển phần
          chưa cấp vào phiếu chờ cho đến khi nguồn được đối chiếu lại.
        </p>
        <ul>
          {data.data.map((row) => (
            <li key={row.productId}>
              <button onClick={() => onReview(row)} type="button">
                <strong>{row.productName}</strong>
                <span>{row.reason ?? 'Có biến động hàng cần xác minh lại tồn nguồn.'}</span>
                <span className="supplier-source-alert-link">Bấm để đối chiếu mặt hàng này →</span>
              </button>
            </li>
          ))}
        </ul>
        {data.totalItems > data.data.length ? (
          <p>
            Hiển thị {data.data.length}/{data.totalItems} mặt hàng. Xem đầy đủ tại màn đối chiếu.
          </p>
        ) : null}
        <p>
          Kiểm tra số Reshare hiện còn cho đặt, đối chiếu các đơn đã trừ rồi lưu cập nhật để mở cấp
          lại.
        </p>
        <div className="dialog__actions">
          <Button
            data-dialog-initial-focus
            onClick={() => onReview(data.data.length === 1 ? data.data[0] : undefined)}
          >
            Đối chiếu ngay
          </Button>
          <Button tone="secondary" onClick={onClose}>
            Tắt thông báo
          </Button>
        </div>
      </section>
    </div>
  );
}
