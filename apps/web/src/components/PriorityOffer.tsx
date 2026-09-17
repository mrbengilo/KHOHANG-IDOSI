import type {
  PriorityOffer as PriorityOfferRecord,
  RespondPriorityOfferRequest,
} from '@idosi/contracts';
import { AlarmClock, ArrowRight, Check, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './Button';

interface MockPriorityOfferProps {
  readonly bags?: number;
  readonly compact?: boolean;
  readonly expiresInSeconds?: number;
  readonly offer?: never;
  readonly product?: string;
}

interface ControlledPriorityOfferProps {
  readonly busyAction: 'ACCEPT' | 'DECLINE' | null;
  readonly canRespond: boolean;
  readonly error: string | null;
  readonly interactionDisabled?: boolean;
  readonly offer: PriorityOfferRecord;
  readonly onExpired: () => void;
  readonly onOpenTicket: () => void;
  readonly onRespond: (input: RespondPriorityOfferRequest) => void;
  readonly productName: string;
}

type PriorityOfferProps = MockPriorityOfferProps | ControlledPriorityOfferProps;

const formatCountdown = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainingSeconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
};

function formatAmount(offer: PriorityOfferRecord): string {
  return offer.offered.kind === 'UNIT'
    ? `${offer.offered.quantity} bao`
    : `${offer.offered.value} kg`;
}

function ControlledPriorityOffer({
  busyAction,
  canRespond,
  error,
  interactionDisabled = false,
  offer,
  onExpired,
  onOpenTicket,
  onRespond,
  productName,
}: ControlledPriorityOfferProps) {
  const [now, setNow] = useState(() => Date.now());
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const headingId = useId();
  const onExpiredRef = useRef(onExpired);
  const expiryNotification = useRef<string | null>(null);

  const remaining = Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - now) / 1000));
  const locallyExpired = offer.status === 'PENDING' && remaining === 0;
  const active = offer.status === 'PENDING' && !locallyExpired;
  const displayedRemaining = active ? remaining : 0;
  const trimmedReason = declineReason.trim();
  const reasonInvalid = trimmedReason.length > 0 && trimmedReason.length < 3;

  useEffect(() => {
    onExpiredRef.current = onExpired;
  }, [onExpired]);

  useEffect(() => {
    if (offer.status !== 'PENDING' || locallyExpired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [locallyExpired, offer.expiresAt, offer.id, offer.status]);

  useEffect(() => {
    if (!locallyExpired || expiryNotification.current === offer.id) return;
    expiryNotification.current = offer.id;
    onExpiredRef.current();
  }, [locallyExpired, offer.id]);

  const message = useMemo(() => {
    if (locallyExpired || offer.status === 'EXPIRED') {
      return 'Lượt ưu tiên đã hết hạn; phiếu chờ gốc vẫn được giữ';
    }
    if (offer.status === 'ACCEPTED') return `Đã nhận đủ ${formatAmount(offer)} ${productName}`;
    if (offer.status === 'DECLINED') return 'Cửa hàng đã từ chối lượt ưu tiên này';
    if (offer.status === 'CANCELLED') return 'Lượt ưu tiên đã được hủy';
    return `Đề nghị ưu tiên ${formatAmount(offer)} ${productName}`;
  }, [locallyExpired, offer, productName]);

  const decline = () => {
    if (reasonInvalid) return;
    onRespond(
      trimmedReason.length > 0
        ? { action: 'DECLINE', reason: trimmedReason }
        : { action: 'DECLINE' },
    );
  };

  return (
    <section aria-labelledby={headingId} aria-live="polite" className="priority-offer">
      <div className="priority-offer__copy">
        <span className="priority-offer__eyebrow">PHIẾU ƯU TIÊN</span>
        <strong id={headingId}>{message}</strong>
        <span>
          {offer.id} • hết hạn {new Date(offer.expiresAt).toLocaleString('vi-VN')}
        </span>
        {error ? (
          <span className="priority-offer__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <div
        aria-label={active ? `Còn ${remaining} giây` : 'Không còn hiệu lực'}
        className="priority-offer__timer"
      >
        <AlarmClock aria-hidden="true" size={18} />
        <span>{formatCountdown(displayedRemaining)}</span>
      </div>
      <div className="priority-offer__actions">
        {canRespond && active ? (
          <>
            <Button
              busy={busyAction === 'ACCEPT'}
              disabled={interactionDisabled || busyAction !== null}
              onClick={() => onRespond({ accepted: offer.offered, action: 'ACCEPT' })}
              tone="success"
            >
              <Check aria-hidden="true" size={16} /> Nhận đủ
            </Button>
            <Button
              aria-controls={`${headingId}-decline`}
              aria-expanded={declining}
              busy={busyAction === 'DECLINE'}
              disabled={interactionDisabled || busyAction !== null}
              onClick={() => setDeclining((value) => !value)}
              tone="secondary"
            >
              <X aria-hidden="true" size={16} /> Từ chối
            </Button>
          </>
        ) : null}
        <Button className="priority-offer__open" onClick={onOpenTicket} tone="secondary">
          Mở phiếu <ArrowRight aria-hidden="true" size={16} />
        </Button>
        {canRespond && active && declining ? (
          <div className="priority-offer__decline" id={`${headingId}-decline`}>
            <label htmlFor={`${headingId}-reason`}>Lý do từ chối (không bắt buộc)</label>
            <input
              aria-describedby={reasonInvalid ? `${headingId}-reason-error` : undefined}
              disabled={interactionDisabled || busyAction !== null}
              id={`${headingId}-reason`}
              maxLength={500}
              onChange={(event) => setDeclineReason(event.target.value)}
              placeholder="Để trống hoặc nhập ít nhất 3 ký tự"
              value={declineReason}
            />
            {reasonInvalid ? (
              <span id={`${headingId}-reason-error`} role="alert">
                Lý do phải có ít nhất 3 ký tự.
              </span>
            ) : null}
            <Button
              busy={busyAction === 'DECLINE'}
              disabled={interactionDisabled || busyAction !== null || reasonInvalid}
              onClick={decline}
              tone="secondary"
            >
              Xác nhận từ chối
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MockPriorityOffer({
  bags = 3,
  compact = false,
  expiresInSeconds = 18 * 60 + 42,
  product = 'Đồ nam',
}: MockPriorityOfferProps) {
  const [remaining, setRemaining] = useState(expiresInSeconds);
  const [state, setState] = useState<'ACTIVE' | 'CONFIRMED' | 'DECLINED'>('ACTIVE');

  useEffect(() => {
    if (state !== 'ACTIVE' || remaining <= 0) return;
    const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [remaining, state]);

  const message = useMemo(() => {
    if (state === 'CONFIRMED') return `Đã xác nhận ${bags} bao ${product}`;
    if (state === 'DECLINED') return 'Đã hủy lượt; phiếu chờ gốc vẫn được giữ';
    if (remaining === 0) return 'Lượt ưu tiên đã hết hạn; phiếu chờ gốc vẫn được giữ';
    return `Bạn đang có phiếu ưu tiên ${bags} bao ${product}`;
  }, [bags, product, remaining, state]);

  return (
    <section aria-live="polite" className="priority-offer">
      <div className="priority-offer__copy">
        <span className="priority-offer__eyebrow">PHIẾU ƯU TIÊN</span>
        <strong>{message}</strong>
        <span>PU-GV-260912-003 • phản hồi đầu tiên được ghi nhận</span>
      </div>
      <div className="priority-offer__timer">
        <AlarmClock aria-hidden="true" size={18} />
        <span>{formatCountdown(remaining)}</span>
      </div>
      {state === 'ACTIVE' && remaining > 0 ? (
        <div className="priority-offer__actions">
          <Button onClick={() => setState('CONFIRMED')} tone="success">
            <Check aria-hidden="true" size={16} /> Xác nhận
          </Button>
          {!compact ? (
            <Button onClick={() => setState('DECLINED')} tone="secondary">
              <X aria-hidden="true" size={16} /> Hủy lượt
            </Button>
          ) : null}
          <Button tone="secondary">
            Mở phiếu <ArrowRight aria-hidden="true" size={16} />
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export function PriorityOffer(props: PriorityOfferProps) {
  return props.offer ? <ControlledPriorityOffer {...props} /> : <MockPriorityOffer {...props} />;
}
