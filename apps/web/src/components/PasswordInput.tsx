import { Eye, EyeOff } from 'lucide-react';
import { useState, type InputHTMLAttributes } from 'react';

export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Ô mật khẩu kèm nút con mắt xem mật khẩu. Trạng thái hiện/ẩn là cục bộ của từng ô,
 * nên ô "mật khẩu" và ô "nhập lại" không lộ nhau ngoài ý muốn. Mặc định luôn là ẩn:
 * component không bao giờ khởi tạo ở trạng thái đang hiện.
 */
export function PasswordInput(props: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  const label = revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu';
  return (
    <>
      <input {...props} type={revealed ? 'text' : 'password'} />
      <button
        aria-label={label}
        aria-pressed={revealed}
        className="password-toggle"
        disabled={props.disabled ?? false}
        onClick={() => setRevealed((current) => !current)}
        title={label}
        type="button"
      >
        {revealed ? <EyeOff aria-hidden="true" size={17} /> : <Eye aria-hidden="true" size={17} />}
      </button>
    </>
  );
}
