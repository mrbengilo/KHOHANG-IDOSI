import type { IdosiStoreCode } from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Store as StoreIcon } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { adminErrorMessage, listIdosiStoreCodes, setIdosiStoreCode } from './adminApi';

const sourceCopy: Record<IdosiStoreCode['source'], string> = {
  STORE: 'Đặt trong ứng dụng',
  ENVIRONMENT_MAP: 'Theo cấu hình máy chủ',
  STORE_CODE: 'Dùng mã cửa hàng',
  MISSING: 'Chưa có mã IDOSI',
};

/** Stores whose sales cannot be synced until an Admin gives them an IDOSI id. */
export function storesMissingIdosiCode(rows: readonly IdosiStoreCode[]): IdosiStoreCode[] {
  return rows.filter((row) => row.source === 'MISSING');
}

export function IdosiStoreCodesPanel() {
  const queryClient = useQueryClient();
  const queryKey = ['admin', 'idosi-store-codes'] as const;
  const codesQuery = useQuery({ queryFn: listIdosiStoreCodes, queryKey, retry: false });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const save = async (row: IdosiStoreCode) => {
    const draft = (drafts[row.storeId] ?? row.idosiStoreCode ?? '').trim();
    setBusyId(row.storeId);
    setMessage(null);
    try {
      const saved = await setIdosiStoreCode(row.storeId, {
        idosiStoreCode: draft || null,
        reason: `Admin cập nhật mã IDOSI của cửa hàng ${row.storeCode}`,
      });
      setMessage({
        kind: 'success',
        text: saved.idosiStoreCode
          ? `${row.storeCode} dùng mã IDOSI ${saved.idosiStoreCode} từ lần đồng bộ kế tiếp.`
          : `${row.storeCode} bỏ mã riêng, dùng lại cấu hình máy chủ hoặc mã cửa hàng.`,
      });
      setDrafts(({ [row.storeId]: _removed, ...rest }) => rest);
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      setMessage({ kind: 'error', text: adminErrorMessage(error) });
    } finally {
      setBusyId(null);
    }
  };

  const rows = codesQuery.data ?? [];
  const missing = storesMissingIdosiCode(rows);
  return (
    <section className="settings-history" aria-labelledby="settings-idosi-stores-heading">
      <div className="settings-section-heading">
        <span className="settings-section-icon settings-section-icon--history">
          <StoreIcon aria-hidden="true" size={18} />
        </span>
        <div>
          <h2 id="settings-idosi-stores-heading">Mã cửa hàng trên IDOSI</h2>
          <p>
            Mã đặt ở đây được ưu tiên hơn cấu hình máy chủ. Cửa hàng mới không cần sửa file cấu hình
            hay khởi động lại hệ thống.
          </p>
        </div>
      </div>
      {message ? (
        <p
          aria-live="polite"
          className={`settings-feedback settings-feedback--${message.kind === 'success' ? 'success' : 'error'}`}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
      {missing.length > 0 ? (
        <p className="settings-feedback settings-feedback--error" role="alert">
          {missing.length} cửa hàng chưa có mã IDOSI nên chưa đồng bộ được doanh số:{' '}
          {missing.map((row) => row.storeCode).join(', ')}.
        </p>
      ) : null}
      {codesQuery.isPending ? (
        <p role="status">Đang tải mã cửa hàng…</p>
      ) : codesQuery.isError ? (
        <p role="alert">{adminErrorMessage(codesQuery.error)}</p>
      ) : (
        <ol className="settings-history-list">
          {rows.map((row) => {
            const draft = drafts[row.storeId] ?? row.idosiStoreCode ?? '';
            const changed = draft.trim() !== (row.idosiStoreCode ?? '');
            return (
              <li key={row.storeId}>
                <div>
                  <strong>
                    {row.storeCode} · {row.storeName}
                    <Badge tone={row.source === 'MISSING' ? 'danger' : 'neutral'}>
                      {sourceCopy[row.source]}
                    </Badge>
                  </strong>
                  <span>Đang dùng: {row.effectiveIdosiStoreCode ?? 'không có'}</span>
                </div>
                <div className="settings-link-actions">
                  <input
                    aria-label={`Mã IDOSI của ${row.storeCode}`}
                    disabled={busyId !== null}
                    maxLength={100}
                    onChange={(event) =>
                      setDrafts({ ...drafts, [row.storeId]: event.target.value })
                    }
                    placeholder={row.effectiveIdosiStoreCode ?? 'Mã trên idosi.io.vn'}
                    value={draft}
                  />
                  <Button
                    busy={busyId === row.storeId}
                    className="settings-clickable"
                    disabled={!changed || busyId !== null}
                    onClick={() => void save(row)}
                    tone="secondary"
                  >
                    Lưu
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
