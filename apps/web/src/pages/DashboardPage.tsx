import { ArrowRight, BellRing, CircleAlert, RefreshCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppShell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { PriorityOffer } from '../components/PriorityOffer';
import { StatCard } from '../components/StatCard';
import { UnavailableFeature } from '../components/UnavailableFeature';
import { mockModeEnabled } from '../lib/api';
import { formatKg, formatVnd } from '../lib/format';
import { storeHealth } from '../lib/data';

const flowItems = [
  { label: 'Nhập xác nhận', value: '58.420 kg', detail: '612 bao', tone: 'info' as const },
  { label: 'Chờ giá vốn', value: '2.340 kg', detail: '26 bao • khóa', tone: 'warning' as const },
  { label: 'Chưa khui', value: '41.260 kg', detail: '428 bao', tone: 'neutral' as const },
  { label: 'Đang bán tại CH', value: '12.680 kg', detail: '176 bao', tone: 'success' as const },
  { label: 'Chờ lọc', value: '4.480 kg', detail: '18 bao', tone: 'priority' as const },
];

export function DashboardPage() {
  const { role, storeKind } = useOutletContext<AppOutletContext>();
  const [period, setPeriod] = useState('month');
  const [updatedAt, setUpdatedAt] = useState('09:15');
  const isWholesale = role === 'STORE' && storeKind === 'WHOLESALE';
  const isStore = role === 'STORE';

  const visibleStores = useMemo(
    () =>
      role === 'ADMIN'
        ? storeHealth
        : storeHealth.filter((store) => store.code === (isWholesale ? 'LX' : 'GV')),
    [isWholesale, role],
  );

  if (!mockModeEnabled) return <UnavailableFeature title="Tổng quan vận hành" />;

  if (isWholesale) {
    return <WholesaleDashboard />;
  }

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button
              onClick={() =>
                setUpdatedAt(
                  new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                )
              }
              tone="secondary"
            >
              <RefreshCcw aria-hidden="true" size={16} /> Đồng bộ
            </Button>
            <Button>Xem việc chờ</Button>
          </>
        }
        description={
          isStore
            ? `Gò Vấp • cập nhật ${updatedAt}`
            : `Toàn chuỗi • Tháng 09/2026 • cập nhật ${updatedAt}`
        }
        title={isStore ? 'Tổng quan cửa hàng' : 'Tổng quan điều hành toàn hệ thống'}
      />

      {role === 'HTKD' || (isStore && !isWholesale) ? <PriorityOffer compact={isStore} /> : null}

      <section className="filter-card" aria-label="Bộ lọc thống kê">
        <div className="segmented-control">
          <button
            className={period === 'cycle' ? 'active' : ''}
            onClick={() => setPeriod('cycle')}
            type="button"
          >
            Theo phiên
          </button>
          <button
            className={period === 'month' ? 'active' : ''}
            onClick={() => setPeriod('month')}
            type="button"
          >
            Theo tháng
          </button>
        </div>
        <label>
          Kỳ báo cáo
          <select defaultValue="2026-09">
            <option value="2026-09">Tháng 09/2026</option>
            <option value="2026-08">Tháng 08/2026</option>
          </select>
        </label>
        {!isStore ? (
          <label>
            Cửa hàng
            <select defaultValue="all">
              <option value="all">Tất cả cửa hàng</option>
              {storeHealth.map((store) => (
                <option key={store.code} value={store.code}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="filter-card__summary">
          <Badge tone="success">10 bán lẻ</Badge>
          <Badge>4 khách sỉ</Badge>
          <span>Khách sỉ không cộng vào doanh thu, chi phí và tồn bán lẻ.</span>
        </div>
      </section>

      <section aria-labelledby="chain-kpi-title">
        <div className="section-heading">
          <div>
            <h2 id="chain-kpi-title">Chỉ số toàn chuỗi</h2>
            <p>Dữ liệu cùng kỳ, không cộng snapshot qua ngày.</p>
          </div>
          <Badge tone="info">Dữ liệu theo cùng kỳ</Badge>
        </div>
        <div className="stats-grid">
          <StatCard
            detail="612 bao • 58.420 kg"
            label="Hàng hóa nhập"
            tone="info"
            value="128 phiếu"
          />
          <StatCard detail="Tiền 1,28 tỷ • VC 42 triệu" label="Tổng giá vốn" value="1,34 tỷ đ" />
          <StatCard
            detail="2,75 tỷ thường • 70 triệu/kg"
            label="Tổng doanh thu"
            tone="success"
            value="2,86 tỷ đ"
          />
          <StatCard detail="428 bao vật lý" label="Tồn cuối kỳ" tone="warning" value="53.940 kg" />
          <StatCard detail="Phiếu nhập trong kỳ" label="Tổng phiếu" value="200" />
          <StatCard detail="16% tổng phiếu" label="Chờ duyệt" tone="warning" value="32" />
          <StatCard
            detail="428 bao • chưa cộng tồn cửa hàng"
            label="Đã duyệt • chưa nhận"
            tone="info"
            value="154"
          />
          <StatCard
            detail="Cửa hàng đã xác nhận thực nhận"
            label="Hoàn thành • đã nhận"
            tone="success"
            value="14"
          />
        </div>
      </section>

      <section className="split-grid" aria-labelledby="flow-title">
        <article className="panel">
          <div className="section-heading section-heading--compact">
            <div>
              <h2 id="flow-title">Luồng hàng hóa toàn hệ thống</h2>
              <p>Luồng bán lẻ; điều chuyển nội bộ không làm tăng tổng tồn.</p>
            </div>
            <Badge tone="success">Ledger đã đối soát</Badge>
          </div>
          <div className="flow-grid">
            {flowItems.map((item) => (
              <div className={`flow-card flow-card--${item.tone}`} key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </div>
            ))}
          </div>
          <div className="conservation-note">
            <CircleAlert aria-hidden="true" size={17} />
            <span>Khui và phân loại chỉ đổi trạng thái nội bộ; mọi xuất kho đều cần chứng từ.</span>
          </div>
        </article>

        <article className="panel alerts-panel">
          <div className="section-heading section-heading--compact">
            <h2>Trung tâm cảnh báo</h2>
            <Badge tone="danger">27 việc</Badge>
          </div>
          {[
            ['Chờ HTKD chốt giá vốn', '8 phiếu • 26 bao đang khóa', '6 giờ', 'warning'],
            ['Ưu tiên sắp hết hạn', '5 offer cần phản hồi trước 09:00', '18 phút', 'success'],
            ['Điều chuyển chờ nhận', '4 phiếu • 1.240 kg', '2 ngày', 'info'],
            ['Lệch cân / nhận thiếu', '3 phiếu cần đối soát', 'P0', 'danger'],
          ].map(([title, detail, badge, tone]) => (
            <div className="alert-row" key={title}>
              <BellRing aria-hidden="true" size={17} />
              <div>
                <strong>{title}</strong>
                <span>{detail}</span>
              </div>
              <Badge tone={tone as 'warning' | 'success' | 'info' | 'danger'}>{badge}</Badge>
            </div>
          ))}
          <Button tone="secondary">
            Xem tất cả & xử lý <ArrowRight aria-hidden="true" size={16} />
          </Button>
        </article>
      </section>

      {!isStore ? <AllocationSnapshot /> : null}

      <section className="panel table-panel" aria-labelledby="store-health-title">
        <div className="section-heading section-heading--compact">
          <div>
            <h2 id="store-health-title">Sức khỏe cửa hàng</h2>
            <p>Chỉ hiển thị dữ liệu trong phạm vi được phân quyền.</p>
          </div>
          <Badge tone="info">{visibleStores.length} cửa hàng</Badge>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Cửa hàng</th>
                <th>Loại</th>
                <th>Chưa khui</th>
                <th>Đang bán tại CH</th>
                <th>Chờ lọc</th>
                <th>Doanh thu</th>
                <th>Sức khỏe</th>
              </tr>
            </thead>
            <tbody>
              {visibleStores.map((store) => (
                <tr key={store.code}>
                  <td data-label="Cửa hàng">
                    <strong>{store.name}</strong>
                    <small>{store.code}</small>
                  </td>
                  <td data-label="Loại">
                    <Badge tone={store.type === 'RETAIL' ? 'info' : 'neutral'}>
                      {store.type === 'RETAIL' ? 'Bán lẻ' : 'Khách sỉ'}
                    </Badge>
                  </td>
                  <td data-label="Chưa khui">
                    {store.type === 'WHOLESALE'
                      ? 'Không áp dụng'
                      : `${store.unopenedBags} bao / ${formatKg(store.unopenedKg)}`}
                  </td>
                  <td data-label="Đang bán tại CH">
                    {store.type === 'WHOLESALE'
                      ? 'Không áp dụng'
                      : `${store.sellingBags} bao / ${formatKg(store.sellingKg)}`}
                  </td>
                  <td data-label="Chờ lọc">
                    {store.type === 'WHOLESALE' ? 'Không áp dụng' : formatKg(store.pendingSortKg)}
                  </td>
                  <td data-label="Doanh thu">{formatVnd(store.revenueVnd)}</td>
                  <td data-label="Sức khỏe">
                    <Badge
                      tone={
                        store.health === 'STABLE'
                          ? 'success'
                          : store.health === 'WATCH'
                            ? 'warning'
                            : 'danger'
                      }
                    >
                      {store.health === 'STABLE'
                        ? 'Ổn định'
                        : store.health === 'WATCH'
                          ? 'Cần xem'
                          : 'Rủi ro'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function AllocationSnapshot() {
  return (
    <section className="panel allocation-snapshot" aria-labelledby="allocation-title">
      <div className="section-heading section-heading--compact">
        <div>
          <h2 id="allocation-title">Phân bổ hàng hóa</h2>
          <p>Snapshot 08:00 • ưu tiên 08:00–09:00 • chốt 09:00</p>
        </div>
        <Badge tone="success">Đã chốt 09:00</Badge>
      </div>
      <div className="allocation-meter">
        <div>
          <span>Nhu cầu</span>
          <strong>620 bao • 100%</strong>
        </div>
        <progress max="620" value="620" />
        <div>
          <span>Đã duyệt</span>
          <strong>428 bao • 69%</strong>
        </div>
        <progress max="620" value="428" />
        <div>
          <span>Thực nhận</span>
          <strong>398 bao • 64%</strong>
        </div>
        <progress max="620" value="398" />
      </div>
      <div className="mini-kpis">
        <div>
          <span>Tỷ lệ đáp ứng</span>
          <strong>69,0%</strong>
        </div>
        <div>
          <span>Tuổi chờ TB</span>
          <strong>1,8 phiên</strong>
        </div>
        <div>
          <span>Chờ lâu nhất</span>
          <strong>4 phiên</strong>
        </div>
      </div>
    </section>
  );
}

function WholesaleDashboard() {
  return (
    <>
      <PageHeader
        description="Chỉ đặt hàng, xem phân bổ, phiếu chờ, lịch sử và thông báo"
        title="Tổng quan khách sỉ"
      />
      <section className="permission-card">
        <strong>Quyền hạn khách sỉ</strong>
        <span>Đặt hàng • xem phân bổ • phiếu chờ</span>
        <small>Không nhận / khui / bán / tồn / điều chuyển</small>
      </section>
      <div className="stats-grid stats-grid--small">
        <StatCard
          detail="Tối đa 2 yêu cầu hoạt động"
          label="Phiếu trong phiên"
          tone="info"
          value="1 / 2"
        />
        <StatCard detail="YC-SI-260912-006" label="Chờ phân bổ" tone="warning" value="2 bao" />
        <StatCard
          detail="Đồ nam 3 • Áo nữ 2"
          label="Kết quả gần nhất"
          tone="success"
          value="5 bao"
        />
        <StatCard
          detail="Không tham gia nghiệp vụ bán lẻ"
          label="Doanh thu kho"
          value="Không áp dụng"
        />
      </div>
    </>
  );
}
