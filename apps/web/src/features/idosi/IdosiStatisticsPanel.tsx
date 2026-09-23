import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IdosiStatisticsScope,
  IdosiStatisticsState,
  IdosiWeightSummary,
} from '@idosi/contracts';
import { AlertTriangle, CloudDownload, Database, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { StatCard } from '../../components/StatCard';
import { formatInteger, formatKg, formatVnd } from '../../lib/format';
import type { StatusTone } from '../../lib/types';
import {
  getIdosiStatistics,
  idosiStatisticsErrorMessage,
  syncIdosiStatistics,
} from './idosiStatisticsApi';
import './idosi-statistics.css';

interface IdosiStatisticsPanelProps {
  readonly storeId: string;
  readonly period?: string;
}

interface FreshnessView {
  readonly detail: string;
  readonly label: string;
  readonly tone: StatusTone;
}

const revenueTypeCopy = {
  NORMAL: 'Bán thường',
  SALE_KG: 'Bán theo kg',
  SALE_PIECE: 'Bán theo cái',
} as const;

const unitCopy = { KG: 'kg', PIECE: 'cái' } as const;

export function currentIdosiPeriod(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    month: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new RangeError('Không thể xác định kỳ thống kê hiện tại.');
  return `${year}-${month}`;
}

export function idosiFreshnessView(state: IdosiStatisticsState): FreshnessView {
  if (state.freshness === 'RESYNC_REQUIRED') {
    return {
      detail:
        'Snapshot cũ thiếu trường đối soát sale và phân loại. Đồng bộ lại để xem số liệu đúng.',
      label: 'Cần đồng bộ lại',
      tone: 'warning',
    };
  }
  if (state.integrationStatus === 'NOT_CONFIGURED') {
    return {
      detail: 'Máy chủ chưa có khóa tích hợp; dữ liệu đã lưu vẫn được giữ nguyên.',
      label: 'Chưa cấu hình',
      tone: 'warning',
    };
  }
  if (state.freshness === 'CURRENT') {
    return {
      detail: 'Lần đồng bộ gần nhất đã hoàn tất thành công.',
      label: 'Đã cập nhật',
      tone: 'success',
    };
  }
  if (state.freshness === 'STALE') {
    return {
      detail: 'Lần đồng bộ mới nhất thất bại; đang hiển thị snapshot thành công gần nhất.',
      label: 'Dữ liệu cũ',
      tone: 'warning',
    };
  }
  return {
    detail: 'Chưa có snapshot thành công cho cửa hàng và kỳ này.',
    label: 'Chưa có dữ liệu',
    tone: 'neutral',
  };
}

function statisticsKey(storeId: string, period: string): readonly string[] {
  return ['idosi-statistics', storeId, period];
}

function monthScope(storeId: string, period: string): IdosiStatisticsScope {
  return { date: null, paymentMethod: null, period, shiftId: null, storeId };
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
}

function displayedWeight(
  weight: Pick<IdosiWeightSummary, 'isComplete' | 'totalKg' | 'knownKg'>,
): number {
  return weight.isComplete && weight.totalKg !== null ? weight.totalKg : weight.knownKg;
}

function weightDetail(weight: IdosiWeightSummary): string {
  if (weight.isComplete) return `Đủ hệ số · bảng ${weight.tableVersion}`;
  return `${formatInteger(weight.missingFactorLines)} dòng thiếu hệ số; chỉ tính phần đã biết`;
}

export function IdosiStatisticsPanel({ storeId, period: sharedPeriod }: IdosiStatisticsPanelProps) {
  const queryClient = useQueryClient();
  const [localPeriod, setPeriod] = useState(currentIdosiPeriod);
  const period = sharedPeriod ?? localPeriod;
  const scope = monthScope(storeId, period);
  const queryKey = statisticsKey(storeId, period);
  const stateQuery = useQuery({
    enabled: Boolean(storeId),
    queryFn: () => getIdosiStatistics(scope),
    queryKey,
    retry: false,
  });
  const syncMutation = useMutation({
    mutationFn: syncIdosiStatistics,
    onSettled: async (_state, _error, syncedScope) => {
      await Promise.all([
        queryClient.invalidateQueries({
          exact: true,
          queryKey: statisticsKey(syncedScope.storeId, syncedScope.period),
        }),
        queryClient.invalidateQueries({ queryKey: ['idosi-sales-summary', syncedScope.period] }),
      ]);
    },
    onSuccess: (state, syncedScope) => {
      queryClient.setQueryData(statisticsKey(syncedScope.storeId, syncedScope.period), state);
    },
  });
  const mutationMatchesScope =
    syncMutation.variables?.storeId === storeId && syncMutation.variables.period === period;

  if (!storeId) {
    return (
      <section className="panel idosi-statistics" aria-labelledby="idosi-statistics-title">
        <div className="section-heading section-heading--compact">
          <div>
            <h2 id="idosi-statistics-title">Thống kê đơn hàng IDOSI</h2>
            <p>Snapshot doanh thu tổng hợp theo cửa hàng, không tác động số dư tồn kho.</p>
          </div>
          <Database aria-hidden="true" />
        </div>
        <EmptyState
          detail="Chọn một cửa hàng ở Chế độ duyệt để đọc hoặc đồng bộ đúng phạm vi."
          title="Chưa chọn cửa hàng"
        />
      </section>
    );
  }

  const state = stateQuery.data;
  const view = state ? idosiFreshnessView(state) : null;
  const snapshot = state?.snapshot ?? null;
  const payload = snapshot?.payload;
  const revenueMismatch = payload
    ? payload.totals.revenueByType.NORMAL +
        payload.totals.revenueByType.SALE_KG +
        payload.totals.revenueByType.SALE_PIECE !==
      payload.totals.revenue
    : false;
  const syncDisabled = state?.integrationStatus === 'NOT_CONFIGURED';

  return (
    <section className="panel idosi-statistics" aria-labelledby="idosi-statistics-title">
      <div className="idosi-statistics__header">
        <div className="section-heading section-heading--compact">
          <div>
            <h2 id="idosi-statistics-title">Thống kê đơn hàng IDOSI</h2>
            <p>Snapshot tổng hợp từ IDOSI; không cộng dồn và không dùng để trừ tồn kho.</p>
          </div>
          {view ? <Badge tone={view.tone}>{view.label}</Badge> : <Database aria-hidden="true" />}
        </div>
        <div className="idosi-statistics__controls">
          {sharedPeriod ? (
            <span>Kỳ thống kê: {period}</span>
          ) : (
            <label>
              Kỳ thống kê
              <input
                disabled={syncMutation.isPending}
                max={currentIdosiPeriod()}
                onChange={(event) => {
                  if (!event.target.value) return;
                  setPeriod(event.target.value);
                  syncMutation.reset();
                }}
                type="month"
                value={period}
              />
            </label>
          )}
          <Button
            busy={mutationMatchesScope && syncMutation.isPending}
            disabled={syncDisabled || syncMutation.isPending || stateQuery.isPending}
            onClick={() => syncMutation.mutate(scope)}
          >
            <CloudDownload aria-hidden="true" size={16} /> Đồng bộ ngay
          </Button>
        </div>
      </div>

      {stateQuery.isPending ? (
        <div className="idosi-statistics__message" role="status">
          <RefreshCw aria-hidden="true" className="idosi-statistics__spinner" size={18} />
          <div>
            <strong>Đang tải trạng thái đồng bộ</strong>
            <span>Không hiển thị số liệu dự phòng trong lúc chờ máy chủ.</span>
          </div>
        </div>
      ) : stateQuery.error ? (
        <div className="idosi-statistics__message idosi-statistics__message--error" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>Không thể tải thống kê IDOSI</strong>
            <span>{idosiStatisticsErrorMessage(stateQuery.error)}</span>
          </div>
          <Button
            busy={stateQuery.isFetching}
            onClick={() => void stateQuery.refetch()}
            tone="secondary"
          >
            Thử lại
          </Button>
        </div>
      ) : null}

      {mutationMatchesScope && syncMutation.error ? (
        <div className="idosi-statistics__message idosi-statistics__message--error" role="alert">
          <AlertTriangle aria-hidden="true" size={18} />
          <div>
            <strong>Đồng bộ không thành công</strong>
            <span>{idosiStatisticsErrorMessage(syncMutation.error)}</span>
          </div>
        </div>
      ) : null}

      {mutationMatchesScope && syncMutation.isSuccess ? (
        <div className="idosi-statistics__message idosi-statistics__message--success" role="status">
          <CloudDownload aria-hidden="true" size={18} />
          <div>
            <strong>Đã lưu snapshot mới</strong>
            <span>Dữ liệu cùng phạm vi được thay thế nguyên trạng, không cộng dồn.</span>
          </div>
        </div>
      ) : null}

      {state && view ? (
        <div className={`idosi-statistics__message idosi-statistics__message--${view.tone}`}>
          {view.tone === 'warning' ? (
            <AlertTriangle aria-hidden="true" size={18} />
          ) : (
            <Database aria-hidden="true" size={18} />
          )}
          <div>
            <strong>{view.label}</strong>
            <span>{view.detail}</span>
            {state.latestAttempt?.status === 'FAILED' && state.latestAttempt.errorMessage ? (
              <span>Lỗi gần nhất: {state.latestAttempt.errorMessage}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {state && !snapshot ? (
        <EmptyState
          detail={
            state.freshness === 'RESYNC_REQUIRED'
              ? 'Snapshot cũ vẫn được lưu trên máy chủ. Bấm “Đồng bộ ngay” để lấy đủ chỉ số theo loại bán.'
              : syncDisabled
                ? 'Admin cần cấu hình khóa tích hợp IDOSI trên máy chủ trước khi đồng bộ.'
                : 'Bấm “Đồng bộ ngay” để tạo snapshot đầu tiên cho kỳ đã chọn.'
          }
          title={
            state.freshness === 'RESYNC_REQUIRED' ? 'Cần đồng bộ lại' : 'Chưa có snapshot thống kê'
          }
        />
      ) : null}

      {payload && snapshot ? (
        <>
          {revenueMismatch ? (
            <div
              className="idosi-statistics__message idosi-statistics__message--warning"
              role="alert"
            >
              <AlertTriangle aria-hidden="true" size={18} />
              <div>
                <strong>Doanh thu ba loại bán không khớp tổng IDOSI</strong>
                <span>Giữ nguyên số nguồn để đối soát; không tự điều chỉnh.</span>
              </div>
            </div>
          ) : null}
          <div className="stats-grid stats-grid--small idosi-statistics__stats">
            <StatCard
              detail={`${formatInteger(payload.totals.cashOrders)} tiền mặt · ${formatInteger(payload.totals.transferOrders)} chuyển khoản`}
              label="Đơn hoạt động"
              tone="info"
              value={formatInteger(payload.totals.orders)}
            />
            <StatCard
              detail={`${formatVnd(payload.totals.cash)} tiền mặt · ${formatVnd(payload.totals.transfer)} chuyển khoản`}
              label="Doanh thu"
              tone="success"
              value={formatVnd(payload.totals.revenue)}
            />
            <StatCard
              detail={weightDetail(payload.products.weight)}
              label={
                payload.products.weight.isComplete ? 'Khối lượng quy đổi' : 'Khối lượng đã biết'
              }
              tone={payload.products.weight.isComplete ? 'success' : 'warning'}
              value={formatKg(displayedWeight(payload.products.weight))}
            />
            <StatCard
              detail={`${formatInteger(payload.products.totalQuantity)} tổng số lượng nguồn`}
              label="Loại sản phẩm"
              value={formatInteger(payload.products.productTypes)}
            />
          </div>

          <div className="idosi-statistics__details">
            <article>
              <h3>Doanh thu theo loại</h3>
              <dl>
                {Object.entries(payload.totals.revenueByType).map(([type, value]) => (
                  <div key={type}>
                    <dt>{revenueTypeCopy[type as keyof typeof revenueTypeCopy]}</dt>
                    <dd>
                      {formatVnd(
                        type === 'NORMAL' ? value - payload.totals.unclassifiedRevenue : value,
                      )}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt>Chưa phân loại ({formatInteger(payload.totals.unclassifiedOrders)} đơn)</dt>
                  <dd>{formatVnd(payload.totals.unclassifiedRevenue)}</dd>
                </div>
                <div>
                  <dt>Tổng doanh thu</dt>
                  <dd>{formatVnd(payload.totals.revenue)}</dd>
                </div>
              </dl>
            </article>
            <article>
              <h3>Số lượng và khối lượng sale</h3>
              <dl>
                <div>
                  <dt>Sale theo cái</dt>
                  <dd>{formatInteger(payload.products.salePieceQuantity)} cái</dd>
                </div>
                <div>
                  <dt>Khối lượng sale theo cái</dt>
                  <dd>
                    {formatKg(displayedWeight(payload.totals.weight.byRevenueType.SALE_PIECE))} ước
                    tính
                    {!payload.totals.weight.byRevenueType.SALE_PIECE.isComplete
                      ? ' · chưa đủ hệ số'
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>Sale theo ký</dt>
                  <dd>{formatKg(payload.totals.weight.byRevenueType.SALE_KG.actualKg)} thực bán</dd>
                </div>
              </dl>
            </article>
            <article>
              <h3>Nguồn & thời điểm</h3>
              <dl>
                <div>
                  <dt>Cửa hàng nguồn</dt>
                  <dd>{payload.store.name}</dd>
                </div>
                <div>
                  <dt>IDOSI tạo dữ liệu</dt>
                  <dd>{formatTimestamp(payload.generatedAt)}</dd>
                </div>
                <div>
                  <dt>Kho lưu snapshot</dt>
                  <dd>{formatTimestamp(snapshot.lastSyncedAt)}</dd>
                </div>
              </dl>
            </article>
          </div>

          {(
            [
              ['day', 'Theo ngày'],
              ['shift', 'Theo ca'],
            ] as const
          ).map(([groupKey, title]) =>
            payload.groups[groupKey].length ? (
              <details className="idosi-statistics__products" key={groupKey}>
                <summary>
                  {title} · {formatInteger(payload.groups[groupKey].length)} dòng
                </summary>
                <div className="responsive-table">
                  <table>
                    <thead>
                      <tr>
                        <th>{groupKey === 'day' ? 'Ngày' : 'Ca'}</th>
                        <th>Bán thường</th>
                        <th>Sale theo ký</th>
                        <th>Sale theo cái</th>
                        <th>Chưa phân loại</th>
                        <th>Tổng</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payload.groups[groupKey].map((group) => (
                        <tr key={group.key}>
                          <td data-label={groupKey === 'day' ? 'Ngày' : 'Ca'}>{group.key}</td>
                          <td data-label="Bán thường">
                            {formatVnd(group.revenueByType.NORMAL - group.unclassifiedRevenue)}
                          </td>
                          <td data-label="Sale theo ký">
                            {formatVnd(group.revenueByType.SALE_KG)}
                          </td>
                          <td data-label="Sale theo cái">
                            {formatVnd(group.revenueByType.SALE_PIECE)}
                          </td>
                          <td data-label="Chưa phân loại">
                            {formatVnd(group.unclassifiedRevenue)}
                          </td>
                          <td data-label="Tổng">
                            {formatVnd(group.revenue)}
                            {group.revenueByType.NORMAL +
                              group.revenueByType.SALE_KG +
                              group.revenueByType.SALE_PIECE !==
                            group.revenue ? (
                              <small> · Lệch số nguồn</small>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null,
          )}

          <div className="idosi-statistics__products">
            <div className="section-heading section-heading--compact">
              <div>
                <h3>Sản phẩm trong snapshot</h3>
                <p>Toàn bộ mặt hàng theo thứ tự nguồn IDOSI.</p>
              </div>
            </div>
            {payload.products.items.length === 0 ? (
              <EmptyState
                detail="Kỳ này chưa có sản phẩm trong đơn hoạt động."
                title="Chưa có sản phẩm"
              />
            ) : (
              <div className="responsive-table">
                <table>
                  <thead>
                    <tr>
                      <th>Sản phẩm</th>
                      <th>Loại doanh thu</th>
                      <th>Đơn</th>
                      <th>Số lượng</th>
                      <th>Khối lượng quy đổi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.products.items.map((item) => (
                      <tr key={`${item.productId}:${item.revenueType}:${item.unit}`}>
                        <td data-label="Sản phẩm">
                          <strong>{item.productName}</strong>
                          <small>{item.productCode ?? item.productId}</small>
                        </td>
                        <td data-label="Loại doanh thu">
                          {item.classification === 'UNCLASSIFIED'
                            ? 'Chưa phân loại'
                            : revenueTypeCopy[item.revenueType]}
                        </td>
                        <td data-label="Đơn">{formatInteger(item.orders)}</td>
                        <td data-label="Số lượng">
                          {new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(
                            item.quantity,
                          )}{' '}
                          {unitCopy[item.unit]}
                        </td>
                        <td data-label="Khối lượng quy đổi">
                          {formatKg(displayedWeight(item.weight))}
                          {!item.weight.isComplete ? <small>Phần đã biết</small> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
