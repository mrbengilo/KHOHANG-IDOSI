import { Clock3, Plus, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppShell';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { UnavailableFeature } from '../components/UnavailableFeature';
import { mockModeEnabled } from '../lib/api';
import { productConversions } from '../lib/data';

interface RequestDraft {
  product: string;
  bags: number;
  note: string;
}

const initialRequests: RequestDraft[] = [
  { product: 'Đồ nam', bags: 3, note: 'Ưu tiên kiện loại A' },
];

export function RequestsPage() {
  const { role, storeKind } = useOutletContext<AppOutletContext>();
  const [requests, setRequests] = useState(initialRequests);
  const [product, setProduct] = useState('Đồ nam');
  const [bags, setBags] = useState(1);
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const remaining = Math.max(0, 2 - requests.length);
  const isWholesale = role === 'STORE' && storeKind === 'WHOLESALE';

  const grouped = useMemo(
    () =>
      requests.reduce<Record<string, number>>((result, request) => {
        result[request.product] = (result[request.product] ?? 0) + request.bags;
        return result;
      }, {}),
    [requests],
  );

  if (!mockModeEnabled) return <UnavailableFeature title="Đặt hàng & kết quả" />;

  const add = () => {
    if (remaining === 0) return;
    setRequests((current) => [...current, { product, bags: Math.max(1, bags), note }]);
    setNote('');
  };

  return (
    <>
      <PageHeader
        description={`${isWholesale ? 'Khách sỉ' : 'Gò Vấp'} • gửi trước 08:00 xét cùng ngày; từ 08:00 chuyển phiên sau`}
        title={isWholesale ? 'Đặt hàng khách sỉ' : 'Đặt hàng & kết quả'}
      />

      <section className="quota-card">
        <div>
          <strong>{requests.length} / 2 phiếu</strong>
          <span>Còn {remaining} yêu cầu mới trong phiên tuần 37</span>
        </div>
        <progress max="2" value={requests.length} />
        <Badge tone={remaining > 0 ? 'info' : 'warning'}>
          {remaining > 0 ? 'Còn lượt' : 'Đã đủ giới hạn'}
        </Badge>
      </section>

      {isWholesale ? (
        <section className="permission-card">
          <strong>Quyền hạn khách sỉ</strong>
          <span>Đặt hàng • xem phân bổ • phiếu chờ</span>
          <small>Không nhận / khui / bán / tồn / điều chuyển</small>
        </section>
      ) : null}

      <div className="request-layout">
        <section className="panel request-form-panel">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Tạo yêu cầu</h2>
              <p>Mỗi yêu cầu có nhiều mặt hàng; tổng tối đa 2 phiếu hoạt động.</p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              Mặt hàng
              <select onChange={(event) => setProduct(event.target.value)} value={product}>
                {productConversions.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Số bao
              <input
                max="999"
                min="1"
                onChange={(event) => setBags(event.target.valueAsNumber || 1)}
                type="number"
                value={bags}
              />
            </label>
            <label className="form-grid__wide">
              Ghi chú
              <textarea
                onChange={(event) => setNote(event.target.value)}
                placeholder="Nhu cầu hoặc ưu tiên vận hành"
                rows={3}
                value={note}
              />
            </label>
          </div>
          <Button disabled={remaining === 0} onClick={add}>
            <Plus aria-hidden="true" size={16} /> Thêm yêu cầu
          </Button>
        </section>

        <section className="panel request-summary">
          <div className="section-heading section-heading--compact">
            <div>
              <h2>Yêu cầu đang soạn</h2>
              <p>Hệ thống chưa kiểm tồn và chưa giữ hàng lúc gửi.</p>
            </div>
          </div>
          {requests.map((request, index) => (
            <article className="request-line" key={`${request.product}-${index + 1}`}>
              <div>
                <strong>
                  Phiếu {index + 1} • {request.product}
                </strong>
                <span>
                  {request.bags} bao • {request.note || 'Không có ghi chú'}
                </span>
              </div>
              <button
                aria-label={`Xóa ${request.product}`}
                onClick={() =>
                  setRequests((current) =>
                    current.filter((_, currentIndex) => currentIndex !== index),
                  )
                }
                type="button"
              >
                <Trash2 size={17} />
              </button>
            </article>
          ))}
          <div className="grouped-demand">
            <strong>Nhu cầu được gộp khi phân bổ</strong>
            {Object.entries(grouped).map(([name, quantity]) => (
              <span key={name}>
                {name}
                <b>{quantity} bao</b>
              </span>
            ))}
          </div>
          <Button disabled={requests.length === 0 || submitted} onClick={() => setSubmitted(true)}>
            <Send aria-hidden="true" size={16} />{' '}
            {submitted ? 'Đã gửi yêu cầu' : 'Gửi yêu cầu đặt hàng'}
          </Button>
        </section>
      </div>

      <section className="panel history-list">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Phiếu chờ phân bổ</h2>
            <p>Mỗi cửa hàng + mặt hàng chỉ có một phiếu chờ đang hoạt động.</p>
          </div>
        </div>
        <article>
          <div>
            <strong>YC-GV-260912-032</strong>
            <span>
              <Clock3 size={14} /> Đồ nam 3 bao • Áo nữ 2 bao
            </span>
          </div>
          <Badge tone="warning">Chờ phân bổ</Badge>
          <button className="link-button" type="button">
            Xem lịch sử
          </button>
        </article>
      </section>
    </>
  );
}
