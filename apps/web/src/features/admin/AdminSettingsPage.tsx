import {
  UpdateOperationalSettingsRequestSchema,
  type IdosiSyncIntervalMinutes,
  type OperationalSettingsOverview,
  type OperationalSettingsVersion,
  type UpdateOperationalSettingsRequest,
} from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, History, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { AdminAccess } from './AdminAccess';
import {
  AdminApiError,
  adminErrorMessage,
  getAdminOperationalSettings,
  updateAdminOperationalSettings,
} from './adminApi';
import './settings.css';

const settingsQueryKey = ['admin', 'operational-settings'] as const;
const historyLimit = 10;

export interface OperationalSettingsDraft {
  readonly timezone: 'Asia/Ho_Chi_Minh';
  readonly snapshotTime: string;
  readonly cutoffTime: string;
  readonly maxRequestsPerStore: string;
  readonly policyVersion: string;
  readonly idosiSyncIntervalMinutes: IdosiSyncIntervalMinutes;
}

export function settingsDraftFromVersion(
  settings: OperationalSettingsVersion,
): OperationalSettingsDraft {
  return {
    timezone: settings.timezone,
    snapshotTime: settings.snapshotTime,
    cutoffTime: settings.cutoffTime,
    maxRequestsPerStore: String(settings.maxRequestsPerStore),
    policyVersion: settings.policyVersion,
    idosiSyncIntervalMinutes: settings.idosiSyncIntervalMinutes,
  };
}

export function settingsUpdateFromDraft(
  draft: OperationalSettingsDraft,
  expectedVersion: number,
): { readonly input: UpdateOperationalSettingsRequest | null; readonly error: string | null } {
  const maxRequests = Number(draft.maxRequestsPerStore);
  if (!/^\d+$/u.test(draft.maxRequestsPerStore.trim()) || !Number.isInteger(maxRequests)) {
    return { error: 'Số yêu cầu tối đa phải là số nguyên.', input: null };
  }
  if (draft.cutoffTime <= draft.snapshotTime) {
    return { error: 'Giờ chốt phải sau giờ snapshot.', input: null };
  }
  if (draft.policyVersion.trim().length < 3) {
    return { error: 'Phiên bản chính sách phải có ít nhất 3 ký tự.', input: null };
  }

  const parsed = UpdateOperationalSettingsRequestSchema.safeParse({
    expectedVersion,
    timezone: draft.timezone,
    snapshotTime: draft.snapshotTime,
    cutoffTime: draft.cutoffTime,
    maxRequestsPerStore: maxRequests,
    policyVersion: draft.policyVersion.trim(),
    idosiSyncIntervalMinutes: draft.idosiSyncIntervalMinutes,
  });
  if (!parsed.success) {
    return { error: 'Cấu hình chưa hợp lệ. Hãy kiểm tra lại các giới hạn.', input: null };
  }
  return { error: null, input: parsed.data };
}

export function AdminSettingsPage() {
  return (
    <AdminAccess>
      <AdminSettingsContent />
    </AdminAccess>
  );
}

function AdminSettingsContent() {
  const queryClient = useQueryClient();
  const [successMessage, setSuccessMessage] = useState('');
  const settingsQuery = useQuery({
    queryFn: () => getAdminOperationalSettings(historyLimit),
    queryKey: settingsQueryKey,
    retry: false,
  });

  const refresh = async () => {
    setSuccessMessage('');
    await settingsQuery.refetch();
  };

  const saveOverview = (overview: OperationalSettingsOverview) => {
    queryClient.setQueryData(settingsQueryKey, overview);
    setSuccessMessage(`Đã lưu cấu hình phiên bản ${overview.current.version}.`);
  };

  return (
    <>
      <PageHeader
        actions={
          <Button
            busy={settingsQuery.isFetching}
            className="settings-clickable"
            onClick={() => void refresh()}
            tone="secondary"
          >
            <RefreshCw aria-hidden="true" size={16} /> Tải lại
          </Button>
        }
        description="Lịch vận hành Asia/Ho_Chi_Minh, phiên bản chính sách và kết nối IDOSI"
        title="Cấu hình vận hành"
      />

      <section className="settings-security-note">
        <ShieldCheck aria-hidden="true" size={22} />
        <div>
          <strong>Secret chỉ tồn tại phía server</strong>
          <span>Frontend chỉ nhận endpoint và trạng thái cấu hình, không nhận giá trị secret.</span>
        </div>
      </section>

      {successMessage ? (
        <p aria-live="polite" className="settings-feedback settings-feedback--success">
          {successMessage}
        </p>
      ) : null}

      {settingsQuery.isPending ? <SettingsLoading /> : null}
      {settingsQuery.isError ? (
        <SettingsLoadError error={settingsQuery.error} onRetry={() => void refresh()} />
      ) : null}
      {settingsQuery.data ? (
        <SettingsEditor
          key={settingsQuery.data.current.id}
          onRefresh={refresh}
          onSaved={saveOverview}
          overview={settingsQuery.data}
        />
      ) : null}
    </>
  );
}

function SettingsEditor({
  onRefresh,
  onSaved,
  overview,
}: {
  readonly onRefresh: () => Promise<void>;
  readonly onSaved: (overview: OperationalSettingsOverview) => void;
  readonly overview: OperationalSettingsOverview;
}) {
  const initialDraft = settingsDraftFromVersion(overview.current);
  const [draft, setDraft] = useState<OperationalSettingsDraft>(initialDraft);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const saveLock = useRef(false);
  const changed = !sameDraft(draft, initialDraft);

  const update = <Key extends keyof OperationalSettingsDraft>(
    key: Key,
    value: OperationalSettingsDraft[Key],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveLock.current) return;
    const parsed = settingsUpdateFromDraft(draft, overview.current.version);
    if (!parsed.input) {
      setActionError(parsed.error ?? 'Cấu hình chưa hợp lệ.');
      return;
    }

    saveLock.current = true;
    setSaving(true);
    setActionError('');
    try {
      onSaved(await updateAdminOperationalSettings(parsed.input));
    } catch (error) {
      setActionError(adminErrorMessage(error));
      if (error instanceof AdminApiError && error.code === 'VERSION_CONFLICT') {
        await onRefresh();
      }
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="settings-grid-live">
        <section className="settings-panel" aria-labelledby="settings-session-heading">
          <div className="settings-section-heading">
            <span className="settings-section-icon">
              <Clock3 aria-hidden="true" size={18} />
            </span>
            <div>
              <h2 id="settings-session-heading">Phiên phân bổ</h2>
              <p>Các mốc giờ áp dụng theo ngày nghiệp vụ tại Việt Nam.</p>
            </div>
          </div>
          <div className="settings-fields">
            <label className="settings-field">
              <span>Múi giờ nghiệp vụ</span>
              <input readOnly value={draft.timezone} />
              <small>Cố định để snapshot và cutoff không lệch ngày.</small>
            </label>
            <label className="settings-field">
              <span className="field-label">Giờ snapshot</span>
              <input
                disabled={saving}
                onChange={(event) => update('snapshotTime', event.target.value)}
                required
                type="time"
                value={draft.snapshotTime}
              />
            </label>
            <label className="settings-field">
              <span className="field-label">Giờ chốt</span>
              <input
                disabled={saving}
                onChange={(event) => update('cutoffTime', event.target.value)}
                required
                type="time"
                value={draft.cutoffTime}
              />
            </label>
            <label className="settings-field">
              <span className="field-label">Số yêu cầu tối đa/cửa hàng</span>
              <input
                disabled={saving}
                inputMode="numeric"
                max={10}
                min={1}
                onChange={(event) => update('maxRequestsPerStore', event.target.value)}
                required
                type="number"
                value={draft.maxRequestsPerStore}
              />
              <small>Giới hạn an toàn từ 1 đến 10 yêu cầu.</small>
            </label>
            <label className="settings-field settings-field--wide">
              <span className="field-label">Phiên bản chính sách</span>
              <input
                disabled={saving}
                maxLength={64}
                minLength={3}
                onChange={(event) => update('policyVersion', event.target.value)}
                required
                value={draft.policyVersion}
              />
            </label>
          </div>
        </section>

        <section className="settings-panel" aria-labelledby="settings-integration-heading">
          <div className="settings-section-heading">
            <span className="settings-section-icon settings-section-icon--integration">
              <ShieldCheck aria-hidden="true" size={18} />
            </span>
            <div>
              <h2 id="settings-integration-heading">Tích hợp IDOSI</h2>
              <p>Thông tin kết nối chỉ đọc; secret không có trong response.</p>
            </div>
          </div>
          <div className="settings-fields">
            <label className="settings-field settings-field--wide">
              <span>Endpoint</span>
              <input
                readOnly
                title={overview.integration.endpoint}
                value={overview.integration.endpoint}
              />
            </label>
            <div className="settings-field settings-field--wide">
              <span>Trạng thái secret phía server</span>
              <div className="settings-integration-status">
                <Badge tone={overview.integration.status === 'CONFIGURED' ? 'success' : 'warning'}>
                  {overview.integration.status === 'CONFIGURED' ? 'Đã cấu hình' : 'Chưa cấu hình'}
                </Badge>
                <small>Giá trị secret không được tải xuống trình duyệt.</small>
              </div>
            </div>
            <label className="settings-field settings-field--wide">
              <span>Chu kỳ tự đồng bộ</span>
              <select
                disabled={saving}
                onChange={(event) =>
                  update('idosiSyncIntervalMinutes', Number(event.target.value) as 15 | 30)
                }
                value={draft.idosiSyncIntervalMinutes}
              >
                <option value={15}>15 phút</option>
                <option value={30}>30 phút</option>
              </select>
            </label>
          </div>
        </section>
      </div>

      <SettingsHistory history={overview.history} />

      <div className="settings-sticky-actions">
        <div aria-live="assertive">
          {actionError ? (
            <p className="settings-feedback settings-feedback--error" role="alert">
              {actionError}
            </p>
          ) : (
            <span>
              Bản hiện tại v{overview.current.version}. Lưu sẽ tạo phiên bản mới, không sửa lịch sử.
            </span>
          )}
        </div>
        <div className="settings-action-buttons">
          <Button
            className="settings-clickable"
            disabled={saving || !changed}
            onClick={() => {
              setDraft(initialDraft);
              setActionError('');
            }}
            tone="secondary"
          >
            Hoàn tác
          </Button>
          <Button busy={saving} className="settings-clickable" disabled={!changed} type="submit">
            <Save aria-hidden="true" size={16} /> Lưu phiên bản mới
          </Button>
        </div>
      </div>
    </form>
  );
}

function SettingsHistory({ history }: { readonly history: readonly OperationalSettingsVersion[] }) {
  return (
    <section className="settings-history" aria-labelledby="settings-history-heading">
      <div className="settings-section-heading">
        <span className="settings-section-icon settings-section-icon--history">
          <History aria-hidden="true" size={18} />
        </span>
        <div>
          <h2 id="settings-history-heading">Lịch sử phiên bản</h2>
          <p>Tối đa {historyLimit} phiên bản gần nhất, mới nhất ở trên.</p>
        </div>
      </div>
      <ol className="settings-history-list">
        {history.map((settings, index) => (
          <li key={settings.id}>
            <div>
              <strong>
                Phiên bản {settings.version}
                {index === 0 ? <Badge tone="info">Hiện tại</Badge> : null}
              </strong>
              <span>
                {settings.snapshotTime} → {settings.cutoffTime} · tối đa{' '}
                {settings.maxRequestsPerStore} yêu cầu · đồng bộ {settings.idosiSyncIntervalMinutes}{' '}
                phút
              </span>
            </div>
            <small>
              {formatSettingsTimestamp(settings.createdAt)} · {settings.policyVersion}
            </small>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SettingsLoading() {
  return (
    <section aria-live="polite" className="settings-state" role="status">
      <span aria-hidden="true" className="admin-spinner" />
      <strong>Đang tải cấu hình vận hành…</strong>
    </section>
  );
}

function SettingsLoadError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  return (
    <section className="settings-state settings-state--error" role="alert">
      <strong>Không thể tải cấu hình vận hành</strong>
      <p>{adminErrorMessage(error)}</p>
      <Button className="settings-clickable" onClick={onRetry} tone="secondary">
        <RefreshCw aria-hidden="true" size={15} /> Thử lại
      </Button>
    </section>
  );
}

function sameDraft(left: OperationalSettingsDraft, right: OperationalSettingsDraft): boolean {
  return (
    left.timezone === right.timezone &&
    left.snapshotTime === right.snapshotTime &&
    left.cutoffTime === right.cutoffTime &&
    left.maxRequestsPerStore === right.maxRequestsPerStore &&
    left.policyVersion === right.policyVersion &&
    left.idosiSyncIntervalMinutes === right.idosiSyncIntervalMinutes
  );
}

function formatSettingsTimestamp(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value));
}
