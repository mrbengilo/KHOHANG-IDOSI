import type {
  PriorityOffer as PriorityOfferRecord,
  RespondPriorityOfferRequest,
} from '@idosi/contracts';
import { AlarmClock, ArrowRight, Check, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from './Button';
import { formatKg } from '../lib/format';

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

function formatAmount(amount: PriorityOfferRecord['offered']): string {
  return amount.kind === 'UNIT' ? `${amount.quantity} bao` : formatKg(amount.value);
}

function formatDeadline(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  });
}

function sessionLabel(offer: PriorityOfferRecord): string {
  const kind = offer.sessionKind === 'MANUAL' ? 'Phiên bổ sung' : 'Phiên chính';
  return offer.sessionCode ? `${kind} ${offer.sessionCode}` : kind;
}

/**
 * The server decides FULL versus PARTIAL from the quantity the store was waiting for when the
 * offer was created; the browser only explains the consequence and never cancels on its own.
 */
function consequenceText(offer: PriorityOfferRecord, deadline: string): string {
  return offer.coverage === 'FULL'
    ? `Đề nghị này đủ toàn bộ số hàng đang chờ. Nếu bấm “Không nhận” hoặc không phản hồi trước ${deadline}, phiếu chờ sẽ bị hủy.`
    : `Đề nghị này chỉ là một phần. Nếu bấm “Không nhận” hoặc không phản hồi trước ${deadline}, phiếu chờ vẫn được giữ nguyên và xét tiếp ở phiên sau.`;
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
  const full = offer.coverage === 'FULL';
  const deadline = formatDeadline(offer.expiresAt);

  useEffect(() => {
    onExpiredRef.current = onExpired;
  }, [onExpired]);

  useEffect(() => {
    if (offer.status !== 'PENDING' || locallyExpired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [locallyExpired, offer.expiresAt, offer.id, offer.status]);

  useEffect(() => {
    // Only refetch: the deadline is enforced and recorded by the server, never by this timer.
    if (!locallyExpired || expiryNotification.current === offer.id) return;
    expiryNotification.current = offer.id;
    onExpiredRef.current();
  }, [locallyExpired, offer.id]);

  const message = useMemo(() => {
    if (locallyExpired || offer.status === 'EXPIRED') {
      return full
        ? 'Đã hết hạn phản hồi đề nghị đủ hàng; hệ thống sẽ hủy phiếu chờ khi chốt phân bổ'
        : 'Lượt ưu tiên đã hết hạn; phiếu chờ gốc vẫn được giữ';
    }
    if (offer.status === 'ACCEPTED') {
      return `Đã nhận ${formatAmount(offer.offered)} ${productName}; hàng được giữ để giao chung đơn thường kế tiếp`;
    }
    if (offer.status === 'DECLINED') {
      return full
        ? 'Cửa hàng không nhận đề nghị đủ hàng; phiếu chờ đã bị hủy'
        : 'Cửa hàng không nhận lượt này; phiếu chờ vẫn được giữ';
    }
    if (offer.status === 'CANCELLED') return 'Lượt ưu tiên đã được hủy cùng phiếu chờ';
    return `Đề nghị nhận ${formatAmount(offer.offered)} ${productName}`;
  }, [full, locallyExpired, offer, productName]);

  const decline = () => {
    if (reasonInvalid) return;
    onRespond(
      trimmedReason.length > 0
        ? { action: 'DECLINE', reason: trimmedReason }
        : { action: 'DECLINE' },
    );
  };

  return (
    <section
      aria-labelledby={headingId}
      aria-live="polite"
      className={`priority-offer${full ? ' priority-offer--full' : ' priority-offer--partial'}`}
    >
      <div className="priority-offer__copy">
        <span className="priority-offer__eyebrow">
          ĐỀ NGHỊ NHẬN HÀNG ƯU TIÊN •{' '}
          <span className="priority-offer__coverage">{full ? 'ĐỦ TOÀN BỘ' : 'MỘT PHẦN'}</span>
        </span>
        <strong id={headingId}>{message}</strong>
        <dl className="priority-offer__facts">
          <div>
            <dt>Đang chờ</dt>
            <dd>{offer.waitingAtOffer ? formatAmount(offer.waitingAtOffer) : 'Chưa ghi nhận'}</dd>
          </div>
          <div>
            <dt>Được đề nghị</dt>
            <dd>{formatAmount(offer.offered)}</dd>
          </div>
          <div>
            <dt>Phiên</dt>
            <dd>{sessionLabel(offer)}</dd>
          </div>
          <div>
            <dt>Hạn phản hồi</dt>
            <dd>{deadline}</dd>
          </div>
        </dl>
        {active ? (
          <span className="priority-offer__consequence">
            Nhận hàng: hàng được giữ trong kho và giao chung với đơn thường kế tiếp, không chiếm
            lượt đặt hàng. {consequenceText(offer, deadline)}
          </span>
        ) : null}
        <span>{offer.code ?? offer.id}</span>
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
              <Check aria-hidden="true" size={16} /> Nhận hàng
            </Button>
            <Button
              aria-controls={`${headingId}-decline`}
              aria-expanded={declining}
              busy={busyAction === 'DECLINE'}
              disabled={interactionDisabled || busyAction !== null}
              onClick={() => setDeclining((value) => !value)}
              tone="secondary"
            >
              <X aria-hidden="true" size={16} /> Không nhận
            </Button>
          </>
        ) : null}
        <Button className="priority-offer__open" onClick={onOpenTicket} tone="secondary">
          Mở phiếu <ArrowRight aria-hidden="true" size={16} />
        </Button>
        {canRespond && active && declining ? (
          <div className="priority-offer__decline" id={`${headingId}-decline`}>
            <p className="priority-offer__warning" role={full ? 'alert' : undefined}>
              {full
                ? 'Không nhận đề nghị đủ hàng sẽ HỦY phiếu chờ ngay. Cửa hàng phải đặt lại nếu vẫn cần mặt hàng này.'
                : 'Không nhận lượt này chỉ trả lại hàng đang giữ; phiếu chờ vẫn được giữ và xét ở phiên sau.'}
            </p>
            <label htmlFor={`${headingId}-reason`}>Lý do không nhận (không bắt buộc)</label>
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
              tone={full ? 'danger' : 'secondary'}
            >
              {full ? 'Xác nhận không nhận và hủy phiếu chờ' : 'Xác nhận không nhận lượt này'}
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
  product = 'Quần áo nam',
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
    if (state === 'DECLINED') return 'Không nhận lượt một phần; phiếu chờ gốc vẫn được giữ';
    if (remaining === 0) return 'Lượt ưu tiên đã hết hạn; phiếu chờ gốc vẫn được giữ';
    return `Đề nghị nhận ${bags} bao ${product} (một phần)`;
  }, [bags, product, remaining, state]);

  return (
    <section aria-live="polite" className="priority-offer">
      <div className="priority-offer__copy">
        <span className="priority-offer__eyebrow">ĐỀ NGHỊ NHẬN HÀNG ƯU TIÊN • MỘT PHẦN</span>
        <strong>{message}</strong>
        <span>Minh họa: không nhận hoặc hết hạn thì phiếu chờ vẫn được giữ</span>
      </div>
      <div className="priority-offer__timer">
        <AlarmClock aria-hidden="true" size={18} />
        <span>{formatCountdown(remaining)}</span>
      </div>
      {state === 'ACTIVE' && remaining > 0 ? (
        <div className="priority-offer__actions">
          <Button onClick={() => setState('CONFIRMED')} tone="success">
            <Check aria-hidden="true" size={16} /> Nhận hàng
          </Button>
          {!compact ? (
            <Button onClick={() => setState('DECLINED')} tone="secondary">
              <X aria-hidden="true" size={16} /> Không nhận
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
