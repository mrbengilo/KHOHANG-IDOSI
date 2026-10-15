import { DataTable } from '../components/DataTable';
import type { InboundReceipt } from '@idosi/contracts';
import { formatInteger } from '../lib/format';

const receivedTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function groupInboundProducts(
  bags: readonly { productId: string }[],
  products: readonly { id: string; name: string }[],
) {
  const names = new Map(products.map((product) => [product.id, product.name]));
  const counts = new Map<string, number>();
  for (const bag of bags) counts.set(bag.productId, (counts.get(bag.productId) ?? 0) + 1);
  return Array.from(counts, ([productId, quantity]) => ({
    productId,
    name: names.get(productId) ?? `Chưa tải được tên mặt hàng (${productId})`,
    quantity,
  }));
}

export function InboundReceiptDetails({
  receipt,
  products,
}: {
  receipt: Pick<InboundReceipt, 'bags' | 'receivedAt' | 'referenceCode'>;
  products: readonly { id: string; name: string }[];
}) {
  const lines = groupInboundProducts(receipt.bags, products);
  return (
    <>
      <p className="inbound-receipt__time">
        Thời gian nhập:{' '}
        <time dateTime={receipt.receivedAt}>
          {receivedTime.format(new Date(receipt.receivedAt))}
        </time>
        {' · giờ Việt Nam'}
      </p>
      <DataTable className="inbound-receipt__products">
        <caption className="sr-only">Mặt hàng trong phiếu {receipt.referenceCode}</caption>
        <thead>
          <tr>
            <th scope="col" className="table-index">
              STT
            </th>
            <th data-primary-column scope="col">
              Mặt hàng
            </th>
            <th scope="col">Số bao</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, rowIndex) => (
            <tr key={line.productId}>
              <td className="table-index" data-label="STT">
                {rowIndex + 1}
              </td>
              <th data-primary-column scope="row">
                {line.name}
              </th>
              <td>{formatInteger(line.quantity)} bao</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th colSpan={2} scope="row">
              Tổng · {formatInteger(lines.length)} mặt hàng
            </th>
            <td>{formatInteger(receipt.bags.length)} bao</td>
          </tr>
        </tfoot>
      </DataTable>
    </>
  );
}
