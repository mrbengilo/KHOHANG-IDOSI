import type { InboundStatistics, InboundStatisticsQuery } from '@idosi/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getInboundStatistics } from '../../lib/api';
import {
  inboundMetricLabel,
  inboundStoreDetailKey,
  inboundStoreDetailQuery,
  sameInboundDetailScope,
} from './inboundStatisticsModel';
import { InboundPagination, InboundProductTable, inboundSourceLabels } from './InboundTables';

type DetailStore = Pick<InboundStatistics['storeRows'][number], 'id' | 'code' | 'name' | 'kind'>;

/**
 * Product breakdown for one store, mounted only while that store is expanded. It reads the parent
 * scope but never writes it, and its product page lives here so it resets on every new store.
 */
export function InboundStoreDetails({
  id,
  store,
  scope,
}: {
  id: string;
  store: DetailStore;
  scope: InboundStatisticsQuery;
}) {
  const [productPage, setProductPage] = useState(1);
  const query = inboundStoreDetailQuery(scope, store, productPage);
  const detail = useQuery({
    queryKey: inboundStoreDetailKey(query),
    queryFn: () => getInboundStatistics(query),
    // Only an earlier page of this exact store and scope may stay visible while the next loads.
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameInboundDetailScope(previousQuery.queryKey[2], query)
        ? previous
        : undefined,
  });
  const headingId = `${id}-heading`;
  const storeLabel = `${store.code} · ${store.name}`;
  const period = scope.periodType === 'DAY' ? scope.date : scope.month;
  const source = inboundSourceLabels[scope.source];
  const sort = `${scope.sortBy === 'bags' ? 'số bao' : 'khối lượng'} ${
    scope.sortDirection === 'desc' ? 'giảm dần' : 'tăng dần'
  }`;
  const data = detail.isError ? undefined : detail.data;
  const complete =
    data && data.dataCompleteness.bagsComplete && data.dataCompleteness.weightComplete;
  return (
    <div
      id={id}
      role="region"
      aria-labelledby={headingId}
      aria-busy={detail.isFetching}
      className="inbound-store-detail"
    >
      <div className="inbound-store-detail-heading">
        <h3 id={headingId}>Chi tiết cửa hàng {storeLabel}</h3>
        <p>
          Kỳ: {period} · Nguồn: {source} · Sắp xếp: {sort} · Asia/Ho_Chi_Minh
        </p>
      </div>
      {detail.isPending && <p role="status">Đang tải chi tiết cửa hàng {store.code}…</p>}
      {detail.isError && (
        <div role="alert" className="inbound-warning inbound-store-detail-error">
          <span>
            Không tải được chi tiết cửa hàng {store.code}. {detail.error.message}
          </span>
          <button type="button" onClick={() => void detail.refetch()} disabled={detail.isFetching}>
            Thử lại
          </button>
        </div>
      )}
      {data && detail.isPlaceholderData && (
        <p role="status">
          Đang tải trang {productPage}. Bên dưới vẫn là trang {data.productPagination.page} của cùng
          cửa hàng và phạm vi.
        </p>
      )}
      {data && !complete && (
        <p role="status" className="inbound-warning">
          Dữ liệu của cửa hàng {store.code} chưa đầy đủ. Số có ghi “đã biết” chưa phải tổng đầy đủ;
          tỷ trọng liên quan chưa xác định.
        </p>
      )}
      {data && (
        <p className="inbound-store-detail-total">
          Tổng nguồn {source}: <strong>{inboundMetricLabel(data.selectedTotal)}</strong>
          {scope.source === 'ALL' &&
            ` (Kho ${inboundMetricLabel(data.overviewAllSources.warehouse)} · Đối tác khác ${inboundMetricLabel(data.overviewAllSources.partner)})`}
        </p>
      )}
      {data && data.productPagination.totalItems === 0 && (
        <p className="inbound-store-detail-empty">
          Cửa hàng {storeLabel} không có dữ liệu nhập trong kỳ {period}, nguồn {source}.
        </p>
      )}
      {data && data.productPagination.totalItems > 0 && (
        <>
          <InboundProductTable
            data={data}
            label={`Mặt hàng nhập của cửa hàng ${store.code}`}
            totalLabel="Tổng cửa hàng"
          />
          <InboundPagination
            label={`mặt hàng của cửa hàng ${store.code}`}
            value={data.productPagination}
            onChange={setProductPage}
          />
        </>
      )}
    </div>
  );
}
