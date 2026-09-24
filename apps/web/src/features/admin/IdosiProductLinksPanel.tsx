import {
  uniqueProductForIdosiName,
  type IdosiProductLink,
  type IdosiProductMatching,
  type UnmatchedIdosiProduct,
} from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { listCatalog } from '../../lib/api';
import { businessDate } from '../../lib/business-time';
import type { ProductConversion as CatalogProduct } from '../../lib/types';
import { adminErrorMessage, getIdosiProductMatching, setIdosiProductLink } from './adminApi';

const reasonCopy: Record<UnmatchedIdosiProduct['reason'], string> = {
  NO_PRODUCT: 'Chưa có mặt hàng kho cùng tên',
  AMBIGUOUS: 'Nhiều mặt hàng kho trùng tên',
  PENDING_SYNC: 'Sẽ tự ghép ở lần đồng bộ tới',
};

/** Candidates (same normalized name) first, then every other product, both alphabetical. */
export function productOptionsFor(
  catalog: readonly CatalogProduct[],
  candidateIds: readonly string[],
): CatalogProduct[] {
  const byName = (left: CatalogProduct, right: CatalogProduct) =>
    left.name.localeCompare(right.name, 'vi');
  const candidates = catalog.filter((product) => candidateIds.includes(product.id)).sort(byName);
  const others = catalog.filter((product) => !candidateIds.includes(product.id)).sort(byName);
  return [...candidates, ...others];
}

/** Items an Admin has to act on: unmatched and not about to be linked by the next sync. */
export function unmatchedNeedingAction(matching: IdosiProductMatching | undefined) {
  return (matching?.unmatched ?? []).filter((item) => item.reason !== 'PENDING_SYNC');
}

export interface ProductAwaitingFirstSale {
  readonly product: CatalogProduct;
  /**
   * True when the first IDOSI sale under this product's name is linked to it automatically.
   * False when another warehouse product shares the name, so an Admin must pick when it sells.
   */
  readonly linksByName: boolean;
}

/**
 * Warehouse products no IDOSI id is linked to yet. IDOSI only reports products that sold, so a
 * product without sales has no IDOSI id to link; it is matched by name at its first sale.
 */
export function productsAwaitingFirstSale(
  catalog: readonly CatalogProduct[],
  links: readonly Pick<IdosiProductLink, 'productId'>[],
): ProductAwaitingFirstSale[] {
  const linked = new Set(links.map((link) => link.productId));
  const candidates = catalog.map((product) => ({
    id: product.id,
    name: product.name,
    isActive: product.status === 'ACTIVE',
  }));
  return catalog
    .filter((product) => !linked.has(product.id))
    .toSorted((left, right) => left.name.trim().localeCompare(right.name.trim(), 'vi'))
    .map((product) => ({
      product,
      linksByName: uniqueProductForIdosiName(candidates, product.name) === product.id,
    }));
}

export function IdosiProductLinksPanel() {
  const queryClient = useQueryClient();
  const period = businessDate().slice(0, 7);
  const queryKey = ['admin', 'idosi-product-links', period] as const;
  const matchingQuery = useQuery({
    queryFn: () => getIdosiProductMatching(period),
    queryKey,
    retry: false,
  });
  const catalogQuery = useQuery({ queryFn: listCatalog, queryKey: ['catalog'], retry: false });
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const catalog = catalogQuery.data ?? [];
  const productName = (id: string) => catalog.find((product) => product.id === id)?.name ?? id;

  const link = async (idosiProductId: string, idosiProductName: string) => {
    const productId = choice[idosiProductId];
    if (!productId) return;
    setBusyId(idosiProductId);
    setMessage(null);
    try {
      const saved = await setIdosiProductLink(idosiProductId, {
        productId,
        idosiProductName,
        reason: `Admin ghép mã IDOSI ${idosiProductName} với mặt hàng kho`,
      });
      setMessage({
        kind: 'success',
        text: `Đã ghép "${idosiProductName}" với ${saved.productName}. Lần đồng bộ IDOSI kế tiếp sẽ trừ/hoàn tồn theo ghép mới.`,
      });
      await queryClient.invalidateQueries({ queryKey });
    } catch (error) {
      setMessage({ kind: 'error', text: adminErrorMessage(error) });
    } finally {
      setBusyId(null);
    }
  };

  const picker = (idosiProductId: string, candidateIds: readonly string[], current?: string) => (
    <select
      aria-label="Mặt hàng kho"
      disabled={busyId !== null}
      onChange={(event) => setChoice({ ...choice, [idosiProductId]: event.target.value })}
      value={choice[idosiProductId] ?? current ?? ''}
    >
      <option value="">Chọn mặt hàng kho</option>
      {productOptionsFor(catalog, candidateIds).map((product) => (
        <option key={product.id} value={product.id}>
          {product.name}
          {product.status === 'INACTIVE' ? ' (ngừng)' : ''}
        </option>
      ))}
    </select>
  );

  const needingAction = unmatchedNeedingAction(matchingQuery.data);
  const linkedRows = matchingQuery.data?.links ?? [];
  const awaiting = productsAwaitingFirstSale(catalog, linkedRows);
  return (
    <section className="settings-history" aria-labelledby="settings-idosi-links-heading">
      <div className="settings-section-heading">
        <span className="settings-section-icon settings-section-icon--history">
          <Link2 aria-hidden="true" size={18} />
        </span>
        <div>
          <h2 id="settings-idosi-links-heading">Ghép mặt hàng IDOSI tháng {period}</h2>
          <p>
            Doanh số IDOSI chỉ trừ tồn cửa hàng khi mã IDOSI đã ghép với đúng một mặt hàng kho. Mã
            chưa ghép thì không trừ tồn nào.
          </p>
        </div>
      </div>
      {message ? (
        <p
          aria-live="polite"
          className={`settings-feedback settings-feedback--${message.kind === 'success' ? 'success' : 'error'}`}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
      {matchingQuery.isPending || catalogQuery.isPending ? (
        <p role="status">Đang tải ghép mặt hàng…</p>
      ) : matchingQuery.isError || catalogQuery.isError ? (
        <p role="alert">{adminErrorMessage(matchingQuery.error ?? catalogQuery.error)}</p>
      ) : (
        <>
          {needingAction.length === 0 ? (
            <p>Mọi mặt hàng IDOSI đã bán trong tháng đều đã được ghép.</p>
          ) : (
            <ol className="settings-history-list">
              {needingAction.map((item) => (
                <li key={item.idosiProductId}>
                  <div>
                    <strong>
                      {item.productName}
                      <Badge tone="warning">{reasonCopy[item.reason]}</Badge>
                    </strong>
                    <span>
                      Mã IDOSI {item.idosiProductId} · bán tại {item.storeCount} cửa hàng
                      {item.candidateProductIds.length > 0
                        ? ` · trùng tên: ${item.candidateProductIds.map(productName).join(', ')}`
                        : ''}
                    </span>
                  </div>
                  <div className="settings-link-actions">
                    {picker(item.idosiProductId, item.candidateProductIds)}
                    <Button
                      busy={busyId === item.idosiProductId}
                      className="settings-clickable"
                      disabled={!choice[item.idosiProductId] || busyId !== null}
                      onClick={() => void link(item.idosiProductId, item.productName)}
                      tone="secondary"
                    >
                      Ghép
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <details className="settings-link-details">
            <summary>Đã ghép ({linkedRows.length + awaiting.length})</summary>
            <ol className="settings-history-list">
              {awaiting.map(({ product, linksByName }) => (
                <li key={`awaiting-${product.id}`}>
                  <div>
                    <strong>
                      {product.name}
                      <Badge tone={linksByName ? 'neutral' : 'warning'}>
                        {linksByName ? 'Ghép theo tên' : 'Trùng tên, cần chọn'}
                      </Badge>
                    </strong>
                    <span>
                      {linksByName
                        ? `Tên IDOSI "${product.name}" → ${product.name}${product.sku ? ` (${product.sku})` : ''}. Chưa có doanh số trên IDOSI; mã IDOSI được ghi nhận tự động ở lần đồng bộ đầu tiên có bán.`
                        : `Có mặt hàng kho khác cùng tên. Khi IDOSI có doanh số, mặt hàng sẽ hiện ở trên để chọn đúng mặt hàng kho.`}
                    </span>
                  </div>
                </li>
              ))}
              {linkedRows.map((linked) => (
                <li key={linked.idosiProductId}>
                  <div>
                    <strong>{linked.firstSeenName}</strong>
                    <span>
                      Mã IDOSI {linked.idosiProductId} → {linked.productName} ({linked.productSku})
                    </span>
                  </div>
                  <div className="settings-link-actions">
                    {picker(linked.idosiProductId, [], linked.productId)}
                    <Button
                      busy={busyId === linked.idosiProductId}
                      className="settings-clickable"
                      disabled={
                        !choice[linked.idosiProductId] ||
                        choice[linked.idosiProductId] === linked.productId ||
                        busyId !== null
                      }
                      onClick={() => void link(linked.idosiProductId, linked.firstSeenName)}
                      tone="secondary"
                    >
                      Đổi
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
