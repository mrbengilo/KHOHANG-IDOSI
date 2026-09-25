import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../../components/Button';
import { TabPanel, Tabs, type TabItem } from '../../components/Tabs';
import { listAccessibleStores, listCatalog } from '../../lib/api';
import { formatInteger } from '../../lib/format';
import { loadWarehouseInventory, loadWarehouseOutboundHistory } from './inventoryApi';
import {
  KEYS,
  readInventoryNavigation,
  withParams,
  type WarehouseTab,
} from './inventoryNavigation';
import { ShortageChecksPanel } from './ShortageChecksPanel';
import './warehouse-inventory.css';

const WAREHOUSE_TAB_ITEMS: readonly TabItem<WarehouseTab>[] = [
  { id: 'stock', label: 'Tồn hiện tại' },
  { id: 'shortage', label: 'Kiểm hàng thiếu' },
  { id: 'history', label: 'Lịch sử xuất' },
];

/** Product and store names for the sub-tabs that show codes of both. */
function useNames() {
  const catalog = useQuery({ queryKey: ['catalog'], queryFn: listCatalog, retry: false });
  const stores = useQuery({
    queryKey: ['stores', 'accessible'],
    queryFn: listAccessibleStores,
    retry: false,
  });
  const productNames = useMemo(
    () => new Map((catalog.data ?? []).map((product) => [product.id, product.name])),
    [catalog.data],
  );
  const storeNames = useMemo(
    () => new Map((stores.data ?? []).map((store) => [store.id, store.name])),
    [stores.data],
  );
  return { catalog, stores, productNames, storeNames };
}

/**
 * Warehouse stock with three sub-tabs. Each sub-tab mounts only its own queries, so opening the
 * stock table never downloads the dispatch history or the shortage checks.
 */
export function WarehouseInventory() {
  const [params, setParams] = useSearchParams();
  const { warehouse } = readInventoryNavigation(params);
  return (
    <>
      <Tabs
        active={warehouse.tab}
        idPrefix="warehouse-inventory"
        items={WAREHOUSE_TAB_ITEMS}
        label="Nội dung kho tổng"
        onChange={(tab) =>
          setParams((current) => withParams(current, { [KEYS.warehouseTab]: tab }))
        }
        size="secondary"
      />
      <TabPanel idPrefix="warehouse-inventory" tab={warehouse.tab}>
        {warehouse.tab === 'stock' ? (
          <WarehouseStock page={warehouse.page} search={warehouse.search} />
        ) : warehouse.tab === 'shortage' ? (
          <WarehouseShortages />
        ) : (
          <WarehouseHistory page={warehouse.historyPage} />
        )}
      </TabPanel>
    </>
  );
}

function WarehouseShortages() {
  const { productNames, storeNames } = useNames();
  return <ShortageChecksPanel productNames={productNames} storeNames={storeNames} />;
}

function WarehouseStock({ page, search }: { readonly page: number; readonly search: string }) {
  const [, setParams] = useSearchParams();
  const [draftSearch, setDraftSearch] = useState(search);
  useEffect(() => setDraftSearch(search), [search]);
  const setPage = (next: number) =>
    setParams((current) => withParams(current, { [KEYS.warehousePage]: next }));
  const inventory = useQuery({
    queryKey: ['warehouse-inventory', page, search],
    queryFn: () => loadWarehouseInventory(page, search),
    retry: false,
  });
  return (
    <section className="panel warehouse-stock-panel" aria-label="Tồn kho tổng theo mặt hàng">
      <h2>Tồn kho hiện tại theo mặt hàng</h2>
      <p>
        Đang có tại kho = có thể xuất + đang giữ/chờ xuất. Đã xuất là số bao lũy kế trên phiếu xuất,
        không phải tồn hiện tại.
      </p>
      <form
        className="inventory-actions"
        onSubmit={(event) => {
          event.preventDefault();
          setParams(
            (current) =>
              withParams(current, {
                [KEYS.warehouseSearch]: draftSearch.trim(),
                [KEYS.warehousePage]: 1,
              }),
            { replace: true },
          );
        }}
      >
        <label>
          Tìm mặt hàng kho tổng
          <input
            type="search"
            maxLength={120}
            value={draftSearch}
            onChange={(event) => setDraftSearch(event.target.value)}
          />
        </label>
        <Button type="submit">Tìm kiếm</Button>
      </form>
      {inventory.isPending ? (
        <p role="status">Đang tải tồn kho tổng…</p>
      ) : inventory.isError ? (
        <p role="alert">Không tải được tồn kho tổng. Hãy bấm Làm mới để thử lại.</p>
      ) : (
        <>
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Mặt hàng</th>
                  <th>Đang có tại kho</th>
                  <th>Đang giữ / chờ xuất</th>
                  <th>Có thể xuất</th>
                  <th>Đã xuất lũy kế</th>
                </tr>
              </thead>
              <tbody>
                {inventory.data.data.map((row) => (
                  <tr key={row.productId}>
                    <td data-label="Mặt hàng">
                      <strong>{row.productName}</strong>
                      <small>{row.sku}</small>
                    </td>
                    <td data-label="Đang có tại kho">{formatInteger(row.onHandBags)} bao</td>
                    <td data-label="Đang giữ / chờ xuất">{formatInteger(row.reservedBags)} bao</td>
                    <td data-label="Có thể xuất">{formatInteger(row.availableBags)} bao</td>
                    <td data-label="Đã xuất lũy kế">{formatInteger(row.dispatchedBags)} bao</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!inventory.data.data.length ? <p>Không có mặt hàng phù hợp.</p> : null}
          <div className="inventory-actions">
            <Button tone="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Trước
            </Button>
            <span>
              Trang {page}/{Math.max(1, inventory.data.pagination.totalPages)}
            </span>
            <Button
              tone="secondary"
              disabled={page >= inventory.data.pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              Sau
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function WarehouseHistory({ page: historyPage }: { readonly page: number }) {
  const [, setParams] = useSearchParams();
  const setHistoryPage = (next: number) =>
    setParams((current) => withParams(current, { [KEYS.warehouseHistoryPage]: next }));
  const history = useQuery({
    queryKey: ['warehouse-outbound-history', historyPage],
    queryFn: () => loadWarehouseOutboundHistory(historyPage),
    retry: false,
  });
  const { catalog, stores, productNames, storeNames } = useNames();
  return (
    <section className="panel warehouse-stock-panel" aria-label="Lịch sử phiếu xuất kho tổng">
      <h2>Phiếu chờ xuất & lịch sử xuất kho</h2>
      {catalog.isError || stores.isError ? (
        <p role="alert">Chưa tải được tên mặt hàng/cửa hàng; tạm hiển thị mã để đối soát.</p>
      ) : null}
      {history.isPending ? (
        <p role="status">Đang tải phiếu xuất…</p>
      ) : history.isError ? (
        <p role="alert">Không tải được lịch sử xuất. Hãy bấm Làm mới để thử lại.</p>
      ) : (
        <>
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Phiếu / cửa hàng</th>
                  <th>Mặt hàng</th>
                  <th>Chờ xuất</th>
                  <th>Đã xuất</th>
                  <th>Thời gian xuất</th>
                </tr>
              </thead>
              <tbody>
                {history.data.data.flatMap((outbound) =>
                  outbound.lines.map((line) => (
                    <tr key={`${outbound.id}:${line.id}`}>
                      <td data-label="Phiếu / cửa hàng">
                        <strong>{outbound.requestNumber}</strong>
                        <small>{storeNames.get(outbound.storeId) ?? outbound.storeId}</small>
                        {outbound.status === 'CANCELLED' ? <small>Đã hủy</small> : null}
                      </td>
                      <td data-label="Mặt hàng">
                        {productNames.get(line.productId) ?? line.productId}
                      </td>
                      <td data-label="Chờ xuất">
                        {formatInteger(
                          outbound.status === 'RESERVED'
                            ? line.reservedUnits - line.dispatchedUnits
                            : 0,
                        )}{' '}
                        bao
                      </td>
                      <td data-label="Đã xuất">{formatInteger(line.dispatchedUnits)} bao</td>
                      <td data-label="Thời gian xuất">
                        {outbound.dispatchedAt
                          ? new Date(outbound.dispatchedAt).toLocaleString('vi-VN', {
                              timeZone: 'Asia/Ho_Chi_Minh',
                            })
                          : 'Chưa xuất'}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          {!history.data.data.length ? <p>Chưa có phiếu xuất kho.</p> : null}
          <div className="inventory-actions">
            <Button
              tone="secondary"
              disabled={historyPage <= 1}
              onClick={() => setHistoryPage(historyPage - 1)}
            >
              Phiếu trước
            </Button>
            <span>
              Trang {historyPage}/{Math.max(1, history.data.pagination.totalPages)}
            </span>
            <Button
              tone="secondary"
              disabled={historyPage >= history.data.pagination.totalPages}
              onClick={() => setHistoryPage(historyPage + 1)}
            >
              Phiếu sau
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
