import { AlarmClock, ArrowRight, Check, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from './Button';

interface PriorityOfferProps {
  product?: string;
  bags?: number;
  expiresInSeconds?: number;
  compact?: boolean;
}

const formatCountdown = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remainingSeconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
};

export function PriorityOffer({
  bags = 3,
  compact = false,
  expiresInSeconds = 18 * 60 + 42,
  product = 'Đồ nam',
}: PriorityOfferProps) {
  const [remaining, setRemaining] = useState(expiresInSeconds);
  const [state, setState] = useState<'ACTIVE' | 'CONFIRMED' | 'DECLINED'>('ACTIVE');

  useEffect(() => {
    if (state !== 'ACTIVE' || remaining <= 0) {
      return;
    }
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
    <section className="priority-offer" aria-live="polite">
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
