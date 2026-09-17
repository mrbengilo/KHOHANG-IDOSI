import { ArrowRight, CheckCircle2, Clock3, Play, RotateCcw, ShieldCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppShell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { PageHeader } from '../components/PageHeader';
import { PriorityOffer } from '../components/PriorityOffer';
import { StatCard } from '../components/StatCard';
import { WaitlistPanel } from '../components/WaitlistPanel';
import { listAccessibleStores, listCatalog, mockModeEnabled } from '../lib/api';
import { allocationRequests as seed } from '../lib/data';
import type { AllocationRequest } from '../lib/types';

const statusText: Record<AllocationRequest['status'], string> = {
  WAITING: 'Phiếu chờ',
  OFFERED: 'Đang ưu tiên',
  ALLOCATED: 'Đã phân bổ',
  DECLINED: 'Đã hủy lượt',
};

export function AllocationPage() {
  const { role } = useOutletContext<AppOutletContext>();
  const [requests, setRequests] = useState(seed);
  const [filter, setFilter] = useState<'ALL' | AllocationRequest['status']>('ALL');
  const [runState, setRunState] = useState<'READY' | 'RUNNING' | 'DONE'>('DONE');

  const visible = useMemo(
    () => requests.filter((request) => filter === 'ALL' || request.status === filter),
    [filter, requests],
  );

  if (!mockModeEnabled) return <ProductionAllocationOversight role={role} />;

  const rerun = () => {
    setRunState('RUNNING');
    window.setTimeout(() => setRunState('DONE'), 700);
  };

  const approve = (id: string) => {
    setRequests((current) =>
      current.map((request) => (request.id === id ? { ...request, status: 'ALLOCATED' } : request)),
    );
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button onClick={rerun} tone="secondary">
              <RotateCcw aria-hidden="true" size={16} /> Chạy lại an toàn
            </Button>
            <Button busy={runState === 'RUNNING'} onClick={rerun}>
              <Play aria-hidden="true" size={16} /> Chốt phân bổ
            </Button>
          </>
        }
        description="Phiên tuần 37 • snapshot 08:00 • ưu tiên 08:00–09:00 • công bố 09:00"
        title="Phân bổ hàng hóa"
      />

      <section aria-label="Tiến trình phiên phân bổ" className="timeline-strip">
        <div className="done">
          <span>Trước 08:00</span>
          <strong>Nhận yêu cầu</strong>
          <small>Tối đa 2 phiếu/cửa hàng</small>
        </div>
        <ArrowRight aria-hidden="true" />
        <div className="done">
          <span>08:00</span>
          <strong>Chụp snapshot</strong>
          <small>Khóa đầu vào chính sách</small>
        </div>
        <ArrowRight aria-hidden="true" />
        <div className="active">
          <span>08:00–09:00</span>
          <strong>Ưu tiên phiếu chờ</strong>
          <small>Hold tạm, chờ phản hồi</small>
        </div>
        <ArrowRight aria-hidden="true" />
        <div className="done">
          <span>09:00</span>
          <strong>Phân bổ vòng</strong>
          <small>1 bao/cửa hàng/vòng</small>
        </div>
      </section>

      <PriorityOffer />

      <div className="stats-grid stats-grid--small">
        <StatCard
          badge="08:00"
          detail="Không cộng hàng nhập sau snapshot"
          label="Tồn đủ điều kiện"
          tone="info"
          value="428 bao"
        />
        <StatCard
          badge="P0A–P3"
          detail="Đã gộp theo cửa hàng + mặt hàng"
          label="Nhu cầu"
          value="620 bao"
        />
        <StatCard
          badge="69%"
          detail="Mỗi cửa hàng tối đa 1 bao/vòng"
          label="Đã cấp"
          tone="success"
          value="428 bao"
        />
        <StatCard
          badge="1 active/SKU"
          detail="Giữ nguyên tuổi chờ khi offer hết hạn"
          label="Phiếu chờ"
          tone="warning"
          value="192 bao"
        />
      </div>

      <section className="policy-card">
        <ShieldCheck aria-hidden="true" size={24} />
        <div>
          <strong>Chính sách ALLOC-v1.2 đã khóa</strong>
          <span>
            Phiếu chờ đã xác nhận → nhóm yêu cầu mới → theo vòng; sắp theo tuổi chờ, tỷ lệ đáp ứng
            thấp, thời gian từ lần nhận SKU gần nhất, cursor và mã cửa hàng.
          </span>
        </div>
        <Badge tone="success">Idempotent</Badge>
      </section>

      <section className="panel table-panel">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Yêu cầu và kết quả</h2>
            <p>Hai yêu cầu trước 08:00 được gộp để không tăng lợi thế theo vòng.</p>
          </div>
          <label className="inline-select">
            Trạng thái
            <select
              onChange={(event) => setFilter(event.target.value as typeof filter)}
              value={filter}
            >
              <option value="ALL">Tất cả</option>
              <option value="WAITING">Phiếu chờ</option>
              <option value="OFFERED">Đang ưu tiên</option>
              <option value="ALLOCATED">Đã phân bổ</option>
              <option value="DECLINED">Đã hủy lượt</option>
            </select>
          </label>
        </div>
        {visible.length === 0 ? (
          <EmptyState
            detail="Đổi bộ lọc hoặc kiểm tra phiên khác."
            title="Không có yêu cầu phù hợp"
          />
        ) : (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Mã phiếu</th>
                  <th>Cửa hàng</th>
                  <th>Mặt hàng</th>
                  <th>Nhu cầu</th>
                  <th>Kết quả</th>
                  <th>Ưu tiên</th>
                  <th>Trạng thái</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((request) => (
                  <tr key={request.id}>
                    <td data-label="Mã phiếu">
                      <strong>{request.id}</strong>
                      <small>
                        <Clock3 aria-hidden="true" size={13} /> {request.submittedAt}
                      </small>
                    </td>
                    <td data-label="Cửa hàng">{request.storeName}</td>
                    <td data-label="Mặt hàng">{request.product}</td>
                    <td data-label="Nhu cầu">{request.requestedBags} bao</td>
                    <td data-label="Kết quả">
                      <strong className="text-success">{request.allocatedBags} cấp</strong>
                      <small>{request.waitlistedBags} chờ</small>
                    </td>
                    <td data-label="Ưu tiên">
                      <Badge tone={request.priority.startsWith('P0') ? 'danger' : 'info'}>
                        {request.priority}
                      </Badge>
                    </td>
                    <td data-label="Trạng thái">
                      <Badge
                        tone={
                          request.status === 'ALLOCATED'
                            ? 'success'
                            : request.status === 'OFFERED'
                              ? 'priority'
                              : 'warning'
                        }
                      >
                        {statusText[request.status]}
                      </Badge>
                    </td>
                    <td data-label="Thao tác">
                      {request.status === 'OFFERED' ? (
                        <button
                          className="link-button"
                          onClick={() => approve(request.id)}
                          type="button"
                        >
                          <CheckCircle2 aria-hidden="true" size={15} /> Xác nhận
                        </button>
                      ) : (
                        <button className="link-button" type="button">
                          Xem lịch sử
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function ProductionAllocationOversight({ role }: Pick<AppOutletContext, 'role'>) {
  const catalogQuery = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const storesQuery = useQuery({
    queryFn: listAccessibleStores,
    queryKey: ['stores', 'accessible'],
    retry: false,
  });
  const productNameById = useMemo(
    () => new Map((catalogQuery.data ?? []).map((product) => [product.id, product.name])),
    [catalogQuery.data],
  );
  const storeNameById = useMemo(
    () => new Map((storesQuery.data ?? []).map((store) => [store.id, store.name])),
    [storesQuery.data],
  );
  const contextError = catalogQuery.error ?? storesQuery.error;

  return (
    <>
      <PageHeader
        description="Dữ liệu phiếu chờ và lượt ưu tiên trong phạm vi được phân quyền"
        title="Giám sát phân bổ hàng hóa"
      />
      {contextError ? (
        <section className="panel form-error" role="alert">
          <p>Không thể tải tên cửa hàng hoặc mặt hàng; mã định danh vẫn được giữ nguyên.</p>
          <Button
            onClick={() => {
              void catalogQuery.refetch();
              void storesQuery.refetch();
            }}
            tone="secondary"
          >
            <RotateCcw aria-hidden="true" size={16} /> Thử tải lại tên
          </Button>
        </section>
      ) : null}
      {catalogQuery.isPending || storesQuery.isPending ? (
        <section aria-live="polite" className="panel">
          Đang tải thông tin đối chiếu…
        </section>
      ) : null}
      <WaitlistPanel
        productNameById={productNameById}
        role={role}
        storeNameById={storeNameById}
        title="Giám sát phiếu chờ"
      />
    </>
  );
}
