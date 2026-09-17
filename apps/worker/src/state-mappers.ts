import type {
  DailyPriorityOfferStatus,
  NewOrderPriority,
  StoreOrderRequestStatus,
  WaitTicketStatus,
} from '@idosi/domain';

export type DatabaseSessionStatus =
  'draft' | 'open' | 'closed' | 'allocating' | 'completed' | 'cancelled';
export type DatabaseOfferStatus = 'offered' | 'accepted' | 'declined' | 'expired' | 'cancelled';
export type DatabaseWaitStatus = 'active' | 'fulfilled' | 'cancelled' | 'expired';
export type DatabaseOrderRequestStatus =
  | 'draft'
  | 'submitted'
  | 'merged'
  | 'partially_allocated'
  | 'allocated'
  | 'waitlisted'
  | 'cancelled';
export type DatabasePriority = 'P0A' | 'P0B' | 'P1' | 'P2' | 'P3';

export function isRunnableSessionStatus(status: DatabaseSessionStatus): boolean {
  switch (status) {
    case 'open':
    case 'closed':
    case 'allocating':
      return true;
    case 'draft':
    case 'completed':
    case 'cancelled':
      return false;
  }
}

export function mapDatabaseOfferStatus(
  status: DatabaseOfferStatus,
  hasAllocationLine: boolean,
): DailyPriorityOfferStatus {
  if (hasAllocationLine) {
    if (status !== 'accepted') {
      throw new Error(`Only an accepted database offer can be consumed (received ${status}).`);
    }
    return 'CONSUMED';
  }
  switch (status) {
    case 'offered':
      return 'PENDING';
    case 'accepted':
      return 'CONFIRMED';
    case 'declined':
      return 'DECLINED';
    case 'expired':
    case 'cancelled':
      return 'EXPIRED';
  }
}

export function mapDatabaseWaitStatus(status: DatabaseWaitStatus): WaitTicketStatus {
  switch (status) {
    case 'active':
      return 'ACTIVE';
    case 'fulfilled':
      return 'FULFILLED';
    case 'cancelled':
    case 'expired':
      return 'CANCELLED';
  }
}

export function mapDatabaseOrderRequestStatus(
  status: DatabaseOrderRequestStatus,
): StoreOrderRequestStatus {
  switch (status) {
    case 'submitted':
      return 'SUBMITTED';
    case 'merged':
    case 'partially_allocated':
    case 'allocated':
    case 'waitlisted':
      return 'MERGED';
    case 'cancelled':
      return 'CANCELLED';
    case 'draft':
      throw new Error('A draft database request cannot enter allocation.');
  }
}

export function mapDatabaseNewOrderPriority(priority: DatabasePriority): NewOrderPriority {
  switch (priority) {
    case 'P0B':
    case 'P1':
    case 'P2':
    case 'P3':
      return priority;
    case 'P0A':
      throw new Error('P0A is reserved for accepted wait-ticket offers.');
  }
}
