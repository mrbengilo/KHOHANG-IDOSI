import type { Store } from '@idosi/contracts';
import { useState } from 'react';
import type { Role } from '../../lib/types';
import { IdosiSalesSummary } from './IdosiSalesSummary';
import { currentIdosiPeriod, IdosiStatisticsPanel } from './IdosiStatisticsPanel';

/** IDOSI snapshots are independent of warehouse documents and their loading failures. */
export function IdosiSalesWorkspace({
  role,
  principalStoreId,
  stores,
}: {
  readonly role: Role;
  readonly principalStoreId: string;
  readonly stores: readonly Store[];
}) {
  const [period, setPeriod] = useState(currentIdosiPeriod);
  const [selectedStoreId, setSelectedStoreId] = useState('');
  const storeId = role === 'STORE' ? principalStoreId : selectedStoreId;

  if (role === 'STORE' && !storeId) {
    return (
      <section className="panel" role="status">
        Đang xác minh cửa hàng để tải thống kê IDOSI…
      </section>
    );
  }

  return (
    <section className="idosi-sales-workspace" aria-label="Dữ liệu bán hàng IDOSI">
      <div className="panel inventory-toolbar">
        <label>
          Kỳ thống kê IDOSI
          <input
            type="month"
            min="2000-01"
            max={currentIdosiPeriod()}
            value={period}
            onChange={(event) => {
              if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setPeriod(event.target.value);
            }}
          />
        </label>
        {role !== 'STORE' ? (
          <label>
            Cửa hàng thống kê IDOSI
            <select value={storeId} onChange={(event) => setSelectedStoreId(event.target.value)}>
              <option value="">Tất cả cửa hàng bán lẻ được phân quyền</option>
              {stores
                .filter((store) => store.kind === 'RETAIL')
                .map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.code} · {store.name}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <p>Thống kê từ idosi.io.vn; bộ lọc này độc lập với chứng từ xuất kho bên dưới.</p>
      </div>
      <IdosiSalesSummary
        key={`summary:${period}:${storeId}`}
        period={period}
        {...(storeId ? { storeId } : {})}
      />
      {storeId ? (
        <IdosiStatisticsPanel
          key={`detail:${period}:${storeId}`}
          storeId={storeId}
          period={period}
        />
      ) : (
        <p>Chọn một cửa hàng để xem trạng thái kết nối và đồng bộ ngay.</p>
      )}
    </section>
  );
}
