import { KeyRound, Lock, Plus, RotateCcw, Search, ShieldCheck, UserCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { UnavailableFeature } from '../components/UnavailableFeature';
import { mockModeEnabled } from '../lib/api';

interface UserRow {
  id: string;
  name: string;
  login: string;
  role: 'ADMIN' | 'HTKD' | 'STORE';
  scope: string;
  status: 'ACTIVE' | 'LOCKED';
}

const initialUsers: UserRow[] = [
  {
    id: 'USR-001',
    name: 'Admin IDOSI',
    login: 'admin',
    role: 'ADMIN',
    scope: 'Toàn hệ thống',
    status: 'ACTIVE',
  },
  {
    id: 'USR-014',
    name: 'Nguyễn An',
    login: 'htkd.an',
    role: 'HTKD',
    scope: 'Gò Vấp, Thủ Đức, Bình Dương',
    status: 'ACTIVE',
  },
  {
    id: 'USR-032',
    name: 'Cửa hàng Gò Vấp',
    login: 'store.gv',
    role: 'STORE',
    scope: 'Gò Vấp',
    status: 'ACTIVE',
  },
  {
    id: 'USR-041',
    name: 'Cửa hàng cũ',
    login: 'store.old',
    role: 'STORE',
    scope: 'Đã gỡ',
    status: 'LOCKED',
  },
];

export function UsersPage() {
  const [users, setUsers] = useState(initialUsers);
  const [query, setQuery] = useState('');
  const visible = useMemo(
    () =>
      users.filter((user) =>
        `${user.name} ${user.login} ${user.scope}`
          .toLocaleLowerCase('vi')
          .includes(query.toLocaleLowerCase('vi')),
      ),
    [query, users],
  );
  const toggle = (id: string) =>
    setUsers((current) =>
      current.map((user) =>
        user.id === id ? { ...user, status: user.status === 'ACTIVE' ? 'LOCKED' : 'ACTIVE' } : user,
      ),
    );
  if (!mockModeEnabled) return <UnavailableFeature title="Tài khoản & phân quyền" />;
  return (
    <>
      <PageHeader
        actions={
          <Button>
            <Plus size={16} /> Thêm tài khoản
          </Button>
        }
        description="Khóa, đổi vai trò hoặc gỡ phân công thu hồi phiên ngay lập tức"
        title="Tài khoản & phân quyền"
      />
      <section className="policy-card">
        <ShieldCheck size={23} />
        <div>
          <strong>Không hiển thị mật khẩu gốc</strong>
          <span>
            Mật khẩu được băm; Admin chỉ có thể đặt lại và bắt buộc đổi ở lần đăng nhập kế tiếp.
          </span>
        </div>
        <Badge tone="success">Server-side RBAC</Badge>
      </section>
      <section className="panel table-panel">
        <div className="section-heading section-heading--compact">
          <div>
            <h2>Danh sách tài khoản</h2>
            <p>Phạm vi HTKD được áp dụng trực tiếp trong truy vấn dữ liệu.</p>
          </div>
          <label className="search-field compact">
            <span className="sr-only">Tìm tài khoản</span>
            <div>
              <Search size={16} />
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm tài khoản"
                value={query}
              />
            </div>
          </label>
        </div>
        <div className="responsive-table">
          <table>
            <thead>
              <tr>
                <th>Tài khoản</th>
                <th>Vai trò</th>
                <th>Phạm vi</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => (
                <tr key={user.id}>
                  <td data-label="Tài khoản">
                    <strong>{user.name}</strong>
                    <small>
                      {user.login} • {user.id}
                    </small>
                  </td>
                  <td data-label="Vai trò">
                    <Badge tone="info">{user.role}</Badge>
                  </td>
                  <td data-label="Phạm vi">{user.scope}</td>
                  <td data-label="Trạng thái">
                    <Badge tone={user.status === 'ACTIVE' ? 'success' : 'danger'}>
                      {user.status === 'ACTIVE' ? 'Hoạt động' : 'Đã khóa'}
                    </Badge>
                  </td>
                  <td data-label="Thao tác">
                    <div className="table-actions">
                      <button type="button">
                        <KeyRound size={15} /> Đặt lại mật khẩu
                      </button>
                      <button onClick={() => toggle(user.id)} type="button">
                        {user.status === 'ACTIVE' ? (
                          <>
                            <Lock size={15} /> Khóa
                          </>
                        ) : (
                          <>
                            <UserCheck size={15} /> Mở khóa
                          </>
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

const events = [
  [
    '09:20:13',
    'store.gv',
    'OPEN_BAG',
    'KK-GV-260912-006',
    'Đang bán tại CH +92,000 kg',
    'req_a47d',
  ],
  ['09:05:44', 'store.gv', 'RECEIVE_ORDER', 'NH-GV-260912-032', 'Nhận đủ 5 bao', 'req_b18f'],
  [
    '09:00:02',
    'worker',
    'ALLOCATION_FINALIZED',
    'PB-260912-001',
    '428 bao / 14 cửa hàng',
    'job_0900',
  ],
  [
    '08:42:19',
    'htkd.an',
    'PRIORITY_CONFIRMED',
    'PU-GV-260912-003',
    'Giữ 3 bao Quần áo nam',
    'req_d901',
  ],
  ['08:00:01', 'worker', 'SNAPSHOT_CREATED', 'SS-260912', 'Snapshot 428 bao', 'job_0800'],
];

export function AuditPage() {
  if (!mockModeEnabled) return <UnavailableFeature title="Nhật ký hệ thống" />;
  return (
    <>
      <PageHeader
        actions={
          <Button tone="secondary">
            <RotateCcw size={16} /> Đối soát lại
          </Button>
        }
        description="Sự kiện bất biến; before/after đã loại bỏ secret và mật khẩu"
        title="Nhật ký hệ thống"
      />
      <section className="panel timeline-list">
        {events.map(([time, actor, action, entity, detail, requestId]) => (
          <article key={requestId}>
            <span className="timeline-list__dot" />
            <time>{time}</time>
            <div>
              <strong>{action}</strong>
              <span>{detail}</span>
              <small>
                {actor} • {entity} • {requestId}
              </small>
            </div>
            <Badge tone="info">Đã ghi sổ</Badge>
          </article>
        ))}
      </section>
    </>
  );
}
