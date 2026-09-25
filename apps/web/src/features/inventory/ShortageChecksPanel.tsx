import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { WarehouseShortageCheck } from '@idosi/contracts';
import { Button } from '../../components/Button';
import { useDraftGuard } from '../../lib/draft-guard';
import { formatInteger } from '../../lib/format';
import { loadPendingShortageChecks, resolveShortageCheck } from './inventoryApi';

type Decision = 'RETURNED_TO_STOCK' | 'LOST';

/**
 * Units a store reported missing stay held in the warehouse until an admin checks the shelf:
 * still here goes back to allocatable stock, lost is written off on-hand with a reason.
 */
export function ShortageChecksPanel({
  productNames,
  storeNames,
}: {
  readonly productNames: ReadonlyMap<string, string>;
  readonly storeNames: ReadonlyMap<string, string>;
}) {
  const queryClient = useQueryClient();
  const checks = useQuery({
    queryKey: ['warehouse-shortage-checks', 'pending'],
    queryFn: loadPendingShortageChecks,
    retry: false,
  });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const keys = useRef(new Map<string, string>());
  useDraftGuard(Object.values(reasons).some((reason) => reason.trim() !== ''));
  const resolve = useMutation({
    mutationFn: ({ check, decision }: { check: WarehouseShortageCheck; decision: Decision }) => {
      const keyScope = `${check.id}:${check.version}:${decision}`;
      const key = keys.current.get(keyScope) ?? crypto.randomUUID();
      keys.current.set(keyScope, key);
      return resolveShortageCheck(
        check.id,
        { decision, reason: (reasons[check.id] ?? '').trim(), expectedVersion: check.version },
        key,
      );
    },
    onSuccess: async (resolved, { check, decision }) => {
      setError('');
      // The check is closed: its typed reason is no longer a draft.
      setReasons(({ [check.id]: _resolved, ...rest }) => rest);
      setNotice(
        decision === 'LOST'
          ? `Đã ghi thất lạc ${resolved.quantity} bao của phiếu ${resolved.receiptNumber}; tồn kho tổng đã giảm.`
          : `Đã trả ${resolved.quantity} bao của phiếu ${resolved.receiptNumber} về hàng có thể phân bổ.`,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['warehouse-shortage-checks'] }),
        queryClient.invalidateQueries({ queryKey: ['warehouse-inventory'] }),
      ]);
    },
    onError: (cause) => {
      setNotice('');
      setError(cause instanceof Error ? cause.message : 'Không xử lý được phiếu kiểm hàng thiếu.');
    },
  });
  const submit = (check: WarehouseShortageCheck, decision: Decision) => {
    if ((reasons[check.id] ?? '').trim().length < 3) {
      setNotice('');
      setError('Ghi lý do xác nhận tối thiểu 3 ký tự trước khi xử lý.');
      return;
    }
    resolve.mutate({ check, decision });
  };

  return (
    <section className="panel warehouse-stock-panel" aria-label="Hàng thiếu chờ kho xác nhận">
      <h2>Hàng thiếu chờ kho xác nhận</h2>
      <p>
        Số bao cửa hàng báo nhận thiếu đang được giữ lại, chưa đem phân bổ. Kiểm tra kệ kho rồi chọn
        Còn ở kho hoặc Thất lạc.
      </p>
      {notice ? (
        <div className="operation-notice operation-notice--success" role="status">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="operation-notice operation-notice--error" role="alert">
          {error}
        </div>
      ) : null}
      {checks.isPending ? (
        <p role="status">Đang tải hàng thiếu chờ xác nhận…</p>
      ) : checks.isError ? (
        <p role="alert">Không tải được hàng thiếu chờ xác nhận. Hãy bấm Làm mới để thử lại.</p>
      ) : checks.data.data.length === 0 ? (
        <p>Không có hàng thiếu nào chờ xác nhận.</p>
      ) : (
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Phiếu nhận / cửa hàng</th>
                <th>Mặt hàng</th>
                <th>Số bao thiếu</th>
                <th>Lý do cửa hàng ghi</th>
                <th>Xác nhận của kho</th>
              </tr>
            </thead>
            <tbody>
              {checks.data.data.map((check) => {
                const busy = resolve.isPending && resolve.variables?.check.id === check.id;
                return (
                  <tr key={check.id}>
                    <td data-label="Phiếu nhận / cửa hàng">
                      <strong>{check.receiptNumber}</strong>
                      <small>{storeNames.get(check.storeId) ?? check.storeId}</small>
                    </td>
                    <td data-label="Mặt hàng">
                      {productNames.get(check.productId) ?? check.productId}
                    </td>
                    <td data-label="Số bao thiếu">{formatInteger(check.quantity)} bao</td>
                    <td data-label="Lý do cửa hàng ghi">{check.shortageReason ?? '—'}</td>
                    <td data-label="Xác nhận của kho">
                      <div className="shortage-check-actions">
                        <input
                          aria-label={`Lý do xác nhận phiếu ${check.receiptNumber}`}
                          maxLength={500}
                          placeholder="Ví dụ: kiểm kệ còn đủ 2 bao"
                          value={reasons[check.id] ?? ''}
                          disabled={resolve.isPending}
                          onChange={(event) =>
                            setReasons((current) => ({
                              ...current,
                              [check.id]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          tone="secondary"
                          busy={busy && resolve.variables?.decision === 'RETURNED_TO_STOCK'}
                          disabled={resolve.isPending}
                          onClick={() => submit(check, 'RETURNED_TO_STOCK')}
                        >
                          Còn ở kho
                        </Button>
                        <Button
                          tone="danger"
                          busy={busy && resolve.variables?.decision === 'LOST'}
                          disabled={resolve.isPending}
                          onClick={() => submit(check, 'LOST')}
                        >
                          Thất lạc
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
