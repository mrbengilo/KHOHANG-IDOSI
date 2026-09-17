import {
  ArrowDownToLine,
  ArrowRight,
  CircleCheck,
  CircleDollarSign,
  CloudDownload,
  PackageOpen,
  Plus,
  Scale,
  Send,
  ShieldAlert,
  Truck,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { UnavailableFeature } from '../components/UnavailableFeature';
import { mockModeEnabled } from '../lib/api';
import { estimateKilograms, itemsPerKilogram, kilogramsPerItem } from '../lib/conversions';
import { inventoryLedger, productConversions } from '../lib/data';
import { formatKg, formatPercent, formatVnd } from '../lib/format';

export function InventoryPage() {
  const [query, setQuery] = useState('');
  const rows = useMemo(
    () =>
      inventoryLedger.filter((row) =>
        `${row.document} ${row.product}`
          .toLocaleLowerCase('vi')
          .includes(query.toLocaleLowerCase('vi')),
      ),
    [query],
  );
  if (!mockModeEnabled) return <UnavailableFeature title="Tồn kho & lịch sử" />;
  return (
    <>
      <PageHeader
        actions={
          <Button tone="secondary">
            <ArrowDownToLine size={16} /> Xuất đối soát
          </Button>
        }
        description="Số dư hiện tại luôn đối soát được với sổ phát sinh bất biến"
        title="Tồn kho & lịch sử"
      />
      <div className="stats-grid stats-grid--small">
        <StatCard detail="12 bao vật lý" label="Hàng chưa khui" tone="info" value="1.180 kg" />
        <StatCard detail="3 bao" label="Đang bán tại CH" value="284 kg" />
        <StatCard detail="1 bao" label="Chờ lọc / xử lý" tone="warning" value="62 kg" />
        <StatCard detail="Nguồn sổ cái" label="Chênh lệch đối soát" tone="success" value="0 kg" />
      </div>
      <section className="panel table-panel">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Nhật ký tồn kho</h2>
            <p>Không sửa hoặc xóa giao dịch; sai sót dùng bút toán đảo.</p>
          </div>
          <label className="inline-select">
            Tìm chứng từ
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Mã hoặc mặt hàng"
              value={query}
            />
          </label>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Thời gian</th>
                <th>Chứng từ</th>
                <th>Mặt hàng</th>
                <th>Nghiệp vụ</th>
                <th>± Bao</th>
                <th>± Kg</th>
                <th>Số dư kg</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td data-label="Thời gian">{row.at}</td>
                  <td data-label="Chứng từ">
                    <strong>{row.document}</strong>
                    <small>{row.id}</small>
                  </td>
                  <td data-label="Mặt hàng">{row.product}</td>
                  <td data-label="Nghiệp vụ">{row.movement}</td>
                  <td data-label="± Bao">
                    {row.bagsDelta > 0 ? '+' : ''}
                    {row.bagsDelta}
                  </td>
                  <td data-label="± Kg">
                    {row.kgDelta > 0 ? '+' : ''}
                    {formatKg(row.kgDelta)}
                  </td>
                  <td data-label="Số dư kg">
                    <strong>{formatKg(row.balanceKg)}</strong>
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

export function OpenBagPage() {
  const [selected, setSelected] = useState<string[]>(['GV-DAM-014']);
  const bags = [
    { id: 'GV-DAM-014', kg: 92 },
    { id: 'GV-DAM-015', kg: 104 },
    { id: 'GV-DAM-016', kg: 88 },
  ];
  const total = bags
    .filter((bag) => selected.includes(bag.id))
    .reduce((sum, bag) => sum + bag.kg, 0);
  if (!mockModeEnabled) return <UnavailableFeature title="Khui kiện" />;
  return (
    <>
      <PageHeader
        description="Chọn đúng Mã bao và số bao cần khui; giữ nguyên tổng kg và giá vốn"
        title="Khui kiện"
      />
      <section className="panel operation-step">
        <div className="operation-step__icon">
          <PackageOpen />
        </div>
        <div>
          <h2>Chọn Mã bao & số bao</h2>
          <p>Phiếu KK-GV-260912-006 • Đầm</p>
        </div>
        <Badge tone="info">Chưa khui 3 bao</Badge>
      </section>
      <section className="panel bag-picker">
        <div>
          {bags.map((bag) => (
            <label className={selected.includes(bag.id) ? 'selected' : ''} key={bag.id}>
              <input
                checked={selected.includes(bag.id)}
                onChange={() =>
                  setSelected((current) =>
                    current.includes(bag.id)
                      ? current.filter((id) => id !== bag.id)
                      : [...current, bag.id],
                  )
                }
                type="checkbox"
              />
              <strong>{bag.id}</strong>
              <span>{formatKg(bag.kg)}</span>
            </label>
          ))}
        </div>
        <aside>
          <span>Trước khui</span>
          <strong>3 bao • 284 kg</strong>
          <ArrowRight />
          <span>Sau khui</span>
          <strong>
            {3 - selected.length} chưa khui • {selected.length} đang bán tại CH
          </strong>
          <small>Đang chọn {formatKg(total)}. Tổng vẫn 284 kg; chỉ đổi trạng thái.</small>
          <Button disabled={selected.length === 0}>Xác nhận khui {selected.length} bao</Button>
        </aside>
      </section>
    </>
  );
}

export function SalesPage() {
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState('09:20');
  const sync = () => {
    setSyncing(true);
    window.setTimeout(() => {
      setSyncing(false);
      setSyncedAt(new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }));
    }, 650);
  };
  if (!mockModeEnabled) return <UnavailableFeature title="Bán & đồng bộ" />;
  return (
    <>
      <PageHeader
        actions={
          <Button busy={syncing} onClick={sync}>
            <CloudDownload size={16} /> Đồng bộ idosi.io.vn
          </Button>
        }
        description={`Nguồn doanh thu và số cái chỉ đọc • cập nhật ${syncedAt}`}
        title="Bán & đồng bộ"
      />
      <section className="sync-status">
        <CircleCheck size={21} />
        <div>
          <strong>Đồng bộ thành công</strong>
          <span>
            Khóa nguồn GV-20260912 • chạy lại sẽ thay thế cùng cửa hàng/kỳ, không cộng dồn.
          </span>
        </div>
        <Badge tone="success">Mới nhất</Badge>
      </section>
      <div className="stats-grid stats-grid--small">
        <StatCard
          detail="126 dòng hàng"
          label="Doanh thu thường"
          tone="success"
          value="31,5 triệu đ"
        />
        <StatCard detail="Đã quy đổi theo mặt hàng" label="Số cái" value="126 cái" />
        <StatCard
          detail="sale_kg dùng kg cân thật"
          label="Khối lượng"
          tone="info"
          value="31,500 kg"
        />
        <StatCard
          detail="Không thay số cái/doanh thu gốc"
          label="Độ đầy đủ"
          tone="success"
          value="100%"
        />
      </div>
      <section className="panel table-panel">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Chi tiết quy đổi theo mặt hàng</h2>
            <p>Chỉ làm tròn sau khi cộng; hệ số thiếu hiển thị rõ, không thành 0.</p>
          </div>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Mặt hàng</th>
                <th>Số cái</th>
                <th>Hệ số</th>
                <th>Kg ước tính</th>
                <th>Doanh thu</th>
                <th>Đối soát</th>
              </tr>
            </thead>
            <tbody>
              {productConversions.slice(0, 5).map((product, index) => (
                <tr key={product.id}>
                  <td data-label="Mặt hàng">{product.name}</td>
                  <td data-label="Số cái">{[18, 12, 22, 30, 44][index]}</td>
                  <td data-label="Hệ số">
                    {product.name.startsWith('Chăn')
                      ? '1 cái = 3 kg'
                      : (() => {
                          const value = itemsPerKilogram(product);
                          return value === null ? 'Thiếu hệ số' : `${value} cái/kg`;
                        })()}
                  </td>
                  <td data-label="Kg ước tính">
                    {(() => {
                      const value = estimateKilograms(product, [18, 12, 22, 30, 44][index] ?? 0);
                      return value === null ? 'Thiếu hệ số' : formatKg(value);
                    })()}
                  </td>
                  <td data-label="Doanh thu">{formatVnd((index + 1) * 2_400_000)}</td>
                  <td data-label="Đối soát">
                    <Badge tone="success">Khớp</Badge>
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

export function SortingPage() {
  const [destroyed, setDestroyed] = useState(5);
  const [cheapKg, setCheapKg] = useState(12);
  const [cheapPieces, setCheapPieces] = useState(20);
  const [charity, setCharity] = useState(8);
  const inputKg = 62;
  const normalKg = 30;
  const sortingProduct = productConversions.find((product) => product.name === 'Đầm');
  const cheapPiecesKg = sortingProduct ? estimateKilograms(sortingProduct, cheapPieces) : null;
  const kilogramsPerCheapPiece = sortingProduct ? kilogramsPerItem(sortingProduct) : null;
  const remaining =
    cheapPiecesKg === null
      ? null
      : inputKg - normalKg - destroyed - cheapKg - cheapPiecesKg - charity;
  const valid = remaining !== null && Math.abs(remaining) < 0.001;
  if (!mockModeEnabled) return <UnavailableFeature title="Lọc & xử lý" />;
  return (
    <>
      <PageHeader
        description="Phiếu LOC-GV-260912-003 • Đầm • bao đã mở KK-GV-006"
        title="Lọc & xử lý"
      />
      <section className="conservation-banner">
        <Scale size={23} />
        <div>
          <strong>Đầu vào phiên lọc: 1 bao • 62,000 kg</strong>
          <span>Kg khui = bán thường + sale rẻ + từ thiện + hủy + hao hụt</span>
        </div>
        <Badge tone={valid ? 'success' : 'danger'}>
          {valid
            ? 'Đã cân bằng'
            : remaining === null
              ? 'Thiếu hệ số'
              : `Còn ${formatKg(remaining)}`}
        </Badge>
      </section>
      <section className="panel sort-grid">
        <div className="sort-result">
          <label>
            Bán thường
            <input disabled value={normalKg} />
          </label>
          <label>
            Sale theo kg
            <input
              min="0"
              onChange={(event) => setCheapKg(event.target.valueAsNumber || 0)}
              type="number"
              value={cheapKg}
            />
          </label>
          <label>
            Sale theo cái
            <input
              min="0"
              onChange={(event) => setCheapPieces(event.target.valueAsNumber || 0)}
              type="number"
              value={cheapPieces}
            />
            <small>
              {kilogramsPerCheapPiece === null
                ? 'Thiếu hệ số quy đổi; không thể lưu chứng từ.'
                : `Ước tính ${formatKg(kilogramsPerCheapPiece)}/cái; chứng từ vẫn giữ số cái.`}
            </small>
          </label>
          <label>
            Từ thiện
            <input
              min="0"
              onChange={(event) => setCharity(event.target.valueAsNumber || 0)}
              type="number"
              value={charity}
            />
          </label>
          <label>
            Chờ xác nhận hủy
            <input
              min="0"
              onChange={(event) => setDestroyed(event.target.valueAsNumber || 0)}
              type="number"
              value={destroyed}
            />
          </label>
        </div>
        <aside>
          <ShieldAlert size={26} />
          <h3>Không reset tồn</h3>
          <p>Mỗi nhánh xuất phải có chứng từ; hủy chỉ trừ kho sau khi được xác nhận.</p>
          <div>
            <span>Tổng đã phân loại</span>
            <strong>{remaining === null ? '—' : formatKg(inputKg - remaining)}</strong>
          </div>
          <Button disabled={!valid}>Lưu chứng từ phân loại</Button>
        </aside>
      </section>
    </>
  );
}

export function TransfersPage() {
  const [status, setStatus] = useState<'DRAFT' | 'TRANSIT' | 'RECEIVED'>('DRAFT');
  if (!mockModeEnabled) return <UnavailableFeature title="Điều chuyển cửa hàng" />;
  return (
    <>
      <PageHeader
        description="Nguồn trừ khi xuất; đích chỉ cộng sau khi xác nhận thực nhận"
        title="Điều chuyển cửa hàng"
      />
      <div className="transfer-timeline">
        <div className="done">
          <CircleCheck />
          <span>Tạo phiếu</span>
        </div>
        <ArrowRight />
        <div className={status !== 'DRAFT' ? 'done' : 'active'}>
          <Truck />
          <span>Đang vận chuyển</span>
        </div>
        <ArrowRight />
        <div className={status === 'RECEIVED' ? 'done' : ''}>
          <CircleCheck />
          <span>Đích xác nhận</span>
        </div>
      </div>
      <section className="panel transfer-form">
        <div>
          <label>
            Cửa hàng nguồn
            <select>
              <option>Gò Vấp</option>
            </select>
          </label>
          <label>
            Cửa hàng đích
            <select>
              <option>Thủ Đức</option>
            </select>
          </label>
          <label>
            Mặt hàng
            <select>
              <option>Đầm</option>
            </select>
          </label>
          <label>
            Mã bao
            <select>
              <option>GV-DAM-014</option>
            </select>
          </label>
          <label>
            Số kg
            <input defaultValue="12.000" inputMode="decimal" />
          </label>
        </div>
        <aside>
          <strong>Bao mới: TR-GV-TD-260912-001</strong>
          <span>Bao GV-DAM-014 • Phiếu lọc LOC-GV-260912-003</span>
          <p>Cửa hàng nguồn không thể xác nhận thay đích. Chênh lệch quay về HTKD xử lý.</p>
          {status === 'DRAFT' ? (
            <Button onClick={() => setStatus('TRANSIT')}>
              <Send size={16} /> Xuất khỏi cửa hàng nguồn
            </Button>
          ) : status === 'TRANSIT' ? (
            <Button onClick={() => setStatus('RECEIVED')}>
              <CircleCheck size={16} /> Đích xác nhận đủ
            </Button>
          ) : (
            <Badge tone="success">Đã nhận • bảo toàn 12,000 kg</Badge>
          )}
        </aside>
      </section>
    </>
  );
}

export function ReportsPage() {
  const revenue: number = 2_860_000_000;
  const cost: number = 1_340_000_000;
  const soldKg: number = 18_540;
  const margin = revenue === 0 ? null : ((revenue - cost) / revenue) * 100;
  const roi = cost === 0 ? null : ((revenue - cost) / cost) * 100;
  if (!mockModeEnabled) return <UnavailableFeature title="Báo cáo hiệu quả" />;
  return (
    <>
      <PageHeader
        actions={
          <Button tone="secondary">
            <ArrowDownToLine size={16} /> Xuất báo cáo
          </Button>
        }
        description="Bán lẻ • số liệu cùng kỳ • drill-down về chứng từ nguồn"
        title="Báo cáo hiệu quả"
      />
      <div className="stats-grid">
        <StatCard
          detail="Doanh thu / kg đầu vào"
          label="Doanh thu"
          tone="success"
          value={formatVnd(revenue)}
        />
        <StatCard
          detail="Tiền hàng + phí trực tiếp; VAT khấu trừ tách riêng"
          label="Giá vốn"
          value={formatVnd(cost)}
        />
        <StatCard
          detail={formatKg(soldKg)}
          label="Biên lợi nhuận gộp"
          tone="info"
          value={formatPercent(margin)}
        />
        <StatCard
          detail="Lô đang chạy là số tạm tính"
          label="ROI"
          tone="warning"
          value={formatPercent(roi)}
        />
      </div>
      <section className="report-grid">
        <article className="panel">
          <h2>Phễu nhập → bán</h2>
          {[
            ['Kg nhập', 58_420, 100],
            ['Đã khui', 41_260, 71],
            ['Đã bán', 18_540, 32],
            ['Chờ lọc', 4_480, 8],
          ].map(([label, value, percent]) => (
            <div className="funnel-row" key={String(label)}>
              <span>{label}</span>
              <div>
                <i style={{ width: `${percent}%` }} />
              </div>
              <strong>{formatKg(Number(value))}</strong>
            </div>
          ))}
        </article>
        <article className="panel">
          <h2>Chất lượng lô hàng</h2>
          <div className="quality-list">
            <span>
              <b>Đầm • GV-DAM-014</b>
              <em>Biên +42,8%</em>
            </span>
            <span>
              <b>Áo nữ • TD-AN-008</b>
              <em>Biên +31,4%</em>
            </span>
            <span>
              <b>Đồ nam • BD-DN-021</b>
              <em>Đang chạy • tạm tính</em>
            </span>
          </div>
        </article>
      </section>
    </>
  );
}

export function CostPage() {
  const [bags, setBags] = useState([100.3, 99.7, 100]);
  const pricePerKg = 22_000;
  const freight = 500_000;
  const handling = 120_000;
  const vat = 660_000;
  const totalKg = bags.reduce((sum, kg) => sum + kg, 0);
  const landed = Math.round(totalKg * pricePerKg + freight + handling);
  if (!mockModeEnabled) return <UnavailableFeature title="Nhập kg & chi phí" />;
  return (
    <>
      <PageHeader
        description="Phiếu YC-260912-032 • cửa hàng đã xác nhận nhận đủ 3 bao"
        title="Nhập kg & chi phí"
      />
      <section className="panel cost-layout">
        <div>
          <h2>Khối lượng theo Mã bao</h2>
          {bags.map((kg, index) => (
            <label key={`bag-${index + 1}`}>
              GV-DN-{String(index + 14).padStart(3, '0')}
              <input
                onChange={(event) =>
                  setBags((current) =>
                    current.map((value, currentIndex) =>
                      currentIndex === index ? event.target.valueAsNumber || 0 : value,
                    ),
                  )
                }
                step="0.001"
                type="number"
                value={kg}
              />
            </label>
          ))}
          <Button tone="secondary">
            <Plus size={16} /> Thêm bao
          </Button>
        </div>
        <aside>
          <CircleDollarSign size={27} />
          <h2>Tổng giá vốn</h2>
          <dl>
            <div>
              <dt>Tiền hàng</dt>
              <dd>{formatVnd(Math.round(totalKg * pricePerKg))}</dd>
            </div>
            <div>
              <dt>Vận chuyển</dt>
              <dd>{formatVnd(freight)}</dd>
            </div>
            <div>
              <dt>Bốc vác</dt>
              <dd>{formatVnd(handling)}</dd>
            </div>
            <div>
              <dt>VAT khấu trừ</dt>
              <dd>{formatVnd(vat)}</dd>
            </div>
            <div>
              <dt>Tổng landed cost</dt>
              <dd>{formatVnd(landed)}</dd>
            </div>
          </dl>
          <strong>
            {formatKg(totalKg)} •{' '}
            {totalKg > 0 ? `${formatVnd(Math.round(landed / totalKg))}/kg` : 'Chưa có khối lượng'}
          </strong>
          <Button>Xác nhận giá vốn</Button>
        </aside>
      </section>
    </>
  );
}
