import type { Store } from '@idosi/contracts';
import type { ProductConversion as CatalogProduct } from '../../lib/types';
import { useSearchParams } from 'react-router-dom';
import { WaitlistPanel, ticketStatusLabel } from '../../components/WaitlistPanel';
import { Button } from '../../components/Button';
import {
  readWaitTicketListNavigation,
  withWaitTicketListNavigation,
} from './waitTicketListNavigation';
import './wait-ticket-list.css';

export function WaitTicketList({
  stores,
  products,
}: {
  readonly stores: readonly Store[];
  readonly products: readonly CatalogProduct[];
}) {
  const [params, setParams] = useSearchParams();
  const filters = readWaitTicketListNavigation(params);
  const update = (changes: Record<string, string | number>) =>
    setParams((current) => withWaitTicketListNavigation(current, changes));
  return (
    <div className="wait-ticket-list">
      <form
        key={params.toString()}
        className="wait-ticket-filters"
        onInput={(event) => {
          const input = event.target;
          if (input instanceof HTMLInputElement) {
            const endInput = event.currentTarget.elements.namedItem(
              'createdTo',
            ) as HTMLInputElement;
            endInput.setCustomValidity('');
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const endInput = event.currentTarget.elements.namedItem('createdTo') as HTMLInputElement;
          const from = String(form.get('createdFrom') ?? '');
          const to = String(form.get('createdTo') ?? '');
          endInput.setCustomValidity(
            from && to && from > to ? 'Ngày kết thúc phải từ ngày bắt đầu trở đi' : '',
          );
          if (!event.currentTarget.reportValidity()) return;
          update(
            Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)])),
          );
        }}
      >
        <label>
          Mã phiếu chờ / ưu tiên
          <input name="q" type="search" maxLength={80} defaultValue={filters.q ?? ''} />
        </label>
        <label>
          Trạng thái
          <select name="status" defaultValue={filters.status ?? ''}>
            <option value="">Tất cả trạng thái</option>
            {Object.entries(ticketStatusLabel).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cửa hàng
          <select name="storeId" defaultValue={filters.storeId ?? ''}>
            <option value="">Tất cả cửa hàng</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mặt hàng
          <select name="productId" defaultValue={filters.productId ?? ''}>
            <option value="">Tất cả mặt hàng</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.sku}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ngày tạo từ (giờ Việt Nam)
          <input
            name="createdFrom"
            type="date"
            defaultValue={filters.createdFrom ?? ''}
            max={filters.createdTo}
          />
        </label>
        <label>
          Ngày tạo đến (giờ Việt Nam)
          <input
            name="createdTo"
            type="date"
            defaultValue={filters.createdTo ?? ''}
            min={filters.createdFrom}
          />
        </label>
        <Button type="submit">Lọc phiếu</Button>
      </form>
      <WaitlistPanel
        role="ADMIN"
        pageFilters={filters}
        onPageChange={(page) => update({ page })}
        productNameById={new Map(products.map((p) => [p.id, p.name]))}
        storeNameById={new Map(stores.map((s) => [s.id, s.name]))}
        title="Danh sách phiếu chờ"
      />
    </div>
  );
}
