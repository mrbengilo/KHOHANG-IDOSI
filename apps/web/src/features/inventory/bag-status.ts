import type { StoreInventoryBagStatus } from '@idosi/contracts';
import type { StatusTone } from '../../lib/types';

export const bagStatusCopy: Record<
  StoreInventoryBagStatus,
  { readonly label: string; readonly tone: StatusTone }
> = {
  IN_TRANSIT: { label: 'Đang vận chuyển', tone: 'info' },
  AVAILABLE: { label: 'Chưa khui', tone: 'success' },
  OPEN: { label: 'Đang bán tại CH', tone: 'info' },
  EMPTY: { label: 'Đã hết', tone: 'neutral' },
  QUARANTINED: { label: 'Cách ly', tone: 'warning' },
  RETURNED: { label: 'Đã trả', tone: 'neutral' },
  LOST: { label: 'Thất lạc', tone: 'danger' },
};
