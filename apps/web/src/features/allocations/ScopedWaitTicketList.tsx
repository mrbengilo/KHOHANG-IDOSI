import type { Store, WaitTicket } from '@idosi/contracts';
import { useSearchParams } from 'react-router-dom';

import { Button } from '../../components/Button';
import { WaitlistPanel } from '../../components/WaitlistPanel';
import { useSession } from '../../lib/auth';
import type { ProductConversion as CatalogProduct } from '../../lib/types';
import type { Role } from '../../lib/types';
import { displayStatusLabel } from './WaitTicketTable';
import {
  readWaitTicketListNavigation,
  withWaitTicketListNavigation,
} from './waitTicketListNavigation';
import './wait-ticket-list.css';

type DisplayStatus = NonNullable<WaitTicket['lineage']>['displayStatus'];

/**
 * "Phiếu chờ ưu tiên" for HTKD, store and wholesale accounts. Filters live in the URL (deep link,
 * reload, Back/Forward) and are applied by the server before paging, so counts always match.
 */
export function ScopedWaitTicketList({
  role,
  stores,
  products,
}: {
  readonly role: Role;
  readonly stores: readonly Store[];
  readonly products: readonly CatalogProduct[];
}) {
  const principal = useSession().data?.principal;
  // A store account works on its own store only (the server enforces the same scope).
  const scopeStoreId =
    role === 'STORE' && principal?.role === 'STORE' && principal.storeId
      ? principal.storeId
      : undefined;
  const [params, setParams] = useSearchParams();
  const filters = readWaitTicketListNavigation(params);
  const update = (changes: Record<string, string | number>) =>
    setParams((current) => withWaitTicketListNavigation(current, changes));
  const multiStore = role !== 'STORE' && stores.length > 1;
  return (
    <div className="wait-ticket-list">
      <form
        key={params.toString()}
        className="wait-ticket-filters"
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
          Mã phiếu chờ / tên mặt hàng
          <input name="q" type="search" maxLength={80} defaultValue={filters.q ?? ''} />
        </label>
        <label>
          Trạng thái
          <select name="displayStatus" defaultValue={filters.displayStatus ?? ''}>
            <option value="">Tất cả trạng thái</option>
            {(Object.entries(displayStatusLabel) as [DisplayStatus, string][]).map(
              ([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>
        {multiStore ? (
          <label>
            Cửa hàng
            <select name="storeId" defaultValue={filters.storeId ?? ''}>
              <option value="">Tất cả cửa hàng được phân công</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Mặt hàng
          <select name="productId" defaultValue={filters.productId ?? ''}>
            <option value="">Tất cả mặt hàng</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tạo từ ngày (giờ Việt Nam)
          <input
            name="createdFrom"
            type="date"
            defaultValue={filters.createdFrom ?? ''}
            max={filters.createdTo}
          />
        </label>
        <label>
          Đến ngày (giờ Việt Nam)
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
        onPageChange={(page) => update({ page })}
        pageFilters={{ ...filters, ...(scopeStoreId ? { storeId: scopeStoreId } : {}) }}
        productNameById={new Map(products.map((product) => [product.id, product.name]))}
        role={role}
        {...(scopeStoreId ? { scopeStoreId } : {})}
        storeNameById={new Map(stores.map((store) => [store.id, store.name]))}
        title="Phiếu chờ ưu tiên"
        variant="scoped"
      />
    </div>
  );
}
