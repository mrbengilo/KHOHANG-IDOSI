import { Download, History, Pencil, Plus, Save, Search, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { businessDate } from '../lib/business-time';
import { itemsPerKilogram, kilogramsPerItem, normalizeKilograms } from '../lib/conversions';
import {
  ApiClientError,
  listCatalog,
  mockModeEnabled,
  saveCatalogProduct,
  setCatalogProductStatus,
} from '../lib/api';
import { productConversions as seed } from '../lib/data';
import type { ProductConversion } from '../lib/types';

interface DraftProduct {
  id?: string;
  name: string;
  itemQuantity: string;
  weightKilograms: string;
}

const emptyDraft: DraftProduct = { name: '', itemQuantity: '', weightKilograms: '' };

const decimal = (value: number, digits = 3): string =>
  new Intl.NumberFormat('vi-VN', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);

function formatItemsPerKilogram(product: ProductConversion): string {
  const value = itemsPerKilogram(product);
  return value === null ? 'Thiếu hệ số' : `${decimal(value)} cái`;
}

function formatKilogramsPerItem(product: ProductConversion): string {
  const value = kilogramsPerItem(product);
  return value === null ? 'Thiếu hệ số' : `${decimal(value)} kg`;
}

export function CatalogPage() {
  const [products, setProducts] = useState<ProductConversion[]>(mockModeEnabled ? seed : []);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ACTIVE');
  const [draft, setDraft] = useState<DraftProduct | null>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const catalogQuery = useQuery({
    enabled: !mockModeEnabled,
    queryFn: listCatalog,
    queryKey: ['catalog'],
    retry: false,
  });

  useEffect(() => {
    if (catalogQuery.data) setProducts(catalogQuery.data);
  }, [catalogQuery.data]);

  const visibleProducts = useMemo(
    () =>
      products.filter(
        (product) =>
          (status === 'ALL' || product.status === status) &&
          product.name.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')),
      ),
    [products, query, status],
  );

  const save = async () => {
    if (!draft) return;
    const itemQuantity = Number(draft.itemQuantity);
    const weightKilograms = normalizeKilograms(draft.weightKilograms);
    if (
      !draft.name.trim() ||
      !Number.isSafeInteger(itemQuantity) ||
      itemQuantity <= 0 ||
      weightKilograms === null
    ) {
      setNotice('Vui lòng nhập tên, số cái nguyên dương và khối lượng tối đa 3 chữ số thập phân.');
      return;
    }
    const next: ProductConversion = {
      id: draft.id ?? `SKU-${String(products.length + 1).padStart(3, '0')}`,
      name: draft.name.trim(),
      itemQuantity,
      weightKilograms,
      status: draft.id
        ? (products.find((product) => product.id === draft.id)?.status ?? 'ACTIVE')
        : 'ACTIVE',
      effectiveDate: businessDate(),
    };
    setSaving(true);
    try {
      if (mockModeEnabled) {
        setProducts((current) =>
          draft.id
            ? current.map((product) =>
                product.id === draft.id ? { ...product, ...next } : product,
              )
            : [...current, next],
        );
      } else {
        const current = draft.id ? products.find((product) => product.id === draft.id) : undefined;
        await saveCatalogProduct(
          {
            effectiveFrom: businessDate(),
            itemQuantity,
            name: next.name,
            weightKilograms,
          },
          current,
        );
        await catalogQuery.refetch();
      }
      setDraft(null);
      setNotice(`Đã lưu ${next.name}. Phiên bản mới có hiệu lực từ hôm nay.`);
    } catch (cause) {
      setNotice(
        cause instanceof ApiClientError
          ? cause.message
          : 'Không thể lưu mặt hàng vì phản hồi máy chủ không hợp lệ.',
      );
    } finally {
      setSaving(false);
    }
  };

  const toggleProduct = async (id: string) => {
    const currentProduct = products.find((product) => product.id === id);
    if (!currentProduct) return;
    const nextStatus = currentProduct.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      if (!mockModeEnabled) await setCatalogProductStatus(id, nextStatus);
      setProducts((current) =>
        current.map((product) =>
          product.id === id ? { ...product, status: nextStatus } : product,
        ),
      );
    } catch (cause) {
      setNotice(cause instanceof ApiClientError ? cause.message : 'Không thể cập nhật trạng thái.');
    }
  };

  const exportCsv = () => {
    const rows = [
      ['Mã', 'Mặt hàng', 'Số cái tỷ lệ', 'Khối lượng tỷ lệ (kg)', 'Ngày hiệu lực', 'Trạng thái'],
      ...visibleProducts.map((product) => [
        product.id,
        product.name,
        String(product.itemQuantity),
        product.weightKilograms ?? '',
        product.effectiveDate,
        product.status,
      ]),
    ];
    const csv = rows
      .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'danh-muc-quy-doi.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button disabled title="Lịch sử phiên bản chưa có API truy vấn" tone="secondary">
              <History aria-hidden="true" size={16} /> Tạo phiên bản mới
            </Button>
            <Button onClick={() => setDraft(emptyDraft)}>
              <Plus aria-hidden="true" size={16} /> Thêm mặt hàng
            </Button>
          </>
        }
        description="Cấu hình dùng khi idosi.io.vn trả số lượng cái theo mặt hàng"
        title="Danh mục & quy đổi bán hàng"
      />

      <section className="formula-card">
        <div>
          <Badge tone="info">Công thức bắt buộc</Badge>
          <strong>Khối lượng ước tính = Số cái bán × Khối lượng tỷ lệ ÷ Số cái tỷ lệ</strong>
          <span>Chỉ làm tròn sau khi cộng; thiếu hệ số phải báo thiếu, không mặc định 0.</span>
        </div>
        <Badge tone="info">Ước tính</Badge>
      </section>

      <div className="stats-grid stats-grid--small">
        <StatCard
          detail="Phiên bản 12/09/2026"
          label="Danh mục có hệ số"
          tone="info"
          value={String(products.filter((product) => !product.conversionMissing).length)}
        />
        <StatCard
          detail="Không có hệ số hết hạn"
          label="Đang hoạt động"
          tone="success"
          value={String(products.filter((product) => product.status === 'ACTIVE').length)}
        />
        <StatCard
          detail="Mặt hàng chưa có hệ số"
          label="Thiếu quy đổi"
          tone="warning"
          value={String(products.filter((product) => product.conversionMissing).length)}
        />
        <StatCard detail="Từ API danh mục" label="Nguồn dữ liệu" value="Đã xác thực" />
      </div>

      <div className="example-grid">
        <article>
          <span>Đầm</span>
          <strong>6 cái ÷ 3 = 2,000 kg</strong>
          <small>Hệ số 3 cái/kg</small>
        </article>
        <article>
          <span>Chăn, ga, bao gối, nệm gòn</span>
          <strong>1 cái × 3 = 3,000 kg</strong>
          <small>Quy đổi cố định 1 cái = 3 kg</small>
        </article>
      </div>

      {notice ? (
        <div className="inline-notice" role="status">
          {notice}
          <button aria-label="Đóng thông báo" onClick={() => setNotice('')} type="button">
            <X size={16} />
          </button>
        </div>
      ) : null}

      {!mockModeEnabled && catalogQuery.isPending ? (
        <div className="inline-notice" role="status">
          Đang tải danh mục từ máy chủ…
        </div>
      ) : null}
      {!mockModeEnabled && catalogQuery.isError ? (
        <div className="form-error" role="alert">
          Không tải được danh mục. Dữ liệu mẫu không được dùng thay cho dữ liệu thật.
        </div>
      ) : null}

      <section className="filter-card catalog-filters" aria-label="Bộ lọc danh mục">
        <label className="search-field">
          <span>Tìm mặt hàng</span>
          <div>
            <Search aria-hidden="true" size={17} />
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nhập tên mặt hàng"
              value={query}
            />
          </div>
        </label>
        <label>
          Trạng thái
          <select
            onChange={(event) => setStatus(event.target.value as typeof status)}
            value={status}
          >
            <option value="ALL">Tất cả trạng thái</option>
            <option value="ACTIVE">Đang hoạt động</option>
            <option value="INACTIVE">Ngừng dùng</option>
          </select>
        </label>
        <label>
          Phiên bản hiệu lực
          <select defaultValue="2026-09-12" disabled={!mockModeEnabled}>
            <option value="2026-09-12">12/09/2026</option>
          </select>
        </label>
        <Button onClick={exportCsv} tone="secondary">
          <Download aria-hidden="true" size={16} /> Tải CSV
        </Button>
      </section>

      <section className="panel table-panel" aria-labelledby="catalog-table-title">
        <div className="section-heading section-heading--compact">
          <div>
            <h2 id="catalog-table-title">Bảng hệ số quy đổi</h2>
            <p>
              {visibleProducts.length}/{products.length} mặt hàng • Admin/HTKD quản lý
            </p>
          </div>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Mặt hàng</th>
                <th>1 kg = số cái</th>
                <th>1 cái = kg</th>
                <th>Ngày hiệu lực</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((product) => (
                <tr key={product.id}>
                  <td data-label="Mặt hàng">
                    <strong>{product.name}</strong>
                    <small>{product.sku ?? product.id}</small>
                  </td>
                  <td data-label="1 kg = số cái">{formatItemsPerKilogram(product)}</td>
                  <td data-label="1 cái = kg">{formatKilogramsPerItem(product)}</td>
                  <td data-label="Ngày hiệu lực">
                    {product.effectiveDate
                      ? new Date(product.effectiveDate).toLocaleDateString('vi-VN')
                      : '—'}
                  </td>
                  <td data-label="Trạng thái">
                    <Badge tone={product.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      {product.status === 'ACTIVE' ? 'Hoạt động' : 'Ngừng dùng'}
                    </Badge>
                  </td>
                  <td data-label="Thao tác">
                    <div className="table-actions">
                      <button
                        onClick={() =>
                          setDraft({
                            id: product.id,
                            name: product.name,
                            itemQuantity:
                              product.itemQuantity === null ? '' : String(product.itemQuantity),
                            weightKilograms: product.weightKilograms ?? '',
                          })
                        }
                        type="button"
                      >
                        <Pencil aria-hidden="true" size={15} /> Sửa
                      </button>
                      <button onClick={() => toggleProduct(product.id)} type="button">
                        {product.status === 'ACTIVE' ? 'Ngừng dùng' : 'Khôi phục'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {draft ? (
        <div className="dialog-backdrop">
          <form
            aria-labelledby="catalog-dialog-title"
            aria-modal="true"
            className="dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !saving) setDraft(null);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
            role="dialog"
          >
            <div className="dialog__header">
              <div>
                <h2 id="catalog-dialog-title">{draft.id ? 'Sửa mặt hàng' : 'Thêm mặt hàng'}</h2>
                <p>Mặt hàng đã phát sinh chỉ được ngừng dùng, không xóa cứng.</p>
              </div>
              <button aria-label="Đóng" onClick={() => setDraft(null)} type="button">
                <X size={20} />
              </button>
            </div>
            <label>
              Tên mặt hàng
              <input
                autoFocus
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
                value={draft.name}
              />
            </label>
            <label>
              Số cái trong tỷ lệ
              <input
                inputMode="numeric"
                min="1"
                onChange={(event) => setDraft({ ...draft, itemQuantity: event.target.value })}
                required
                step="1"
                value={draft.itemQuantity}
              />
            </label>
            <label>
              Khối lượng tương ứng (kg)
              <input
                inputMode="decimal"
                min="0.001"
                onChange={(event) => setDraft({ ...draft, weightKilograms: event.target.value })}
                required
                step="0.001"
                value={draft.weightKilograms}
              />
            </label>
            <div className="dialog__summary">
              <span>1 cái tương ứng</span>
              <strong>
                {(() => {
                  const normalizedWeight = normalizeKilograms(draft.weightKilograms);
                  const quantity = Number(draft.itemQuantity);
                  return normalizedWeight !== null && Number.isSafeInteger(quantity) && quantity > 0
                    ? `${decimal(Number(normalizedWeight) / quantity)} kg`
                    : '—';
                })()}
              </strong>
            </div>
            <div className="dialog__actions">
              <Button onClick={() => setDraft(null)} tone="secondary">
                Hủy
              </Button>
              <Button busy={saving} type="submit">
                <Save aria-hidden="true" size={16} /> Lưu phiên bản
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
