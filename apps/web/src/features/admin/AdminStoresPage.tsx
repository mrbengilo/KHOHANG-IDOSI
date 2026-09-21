import {
  CreateStoreGroupRequestSchema,
  CreateStoreRequestSchema,
  UpdateStoreGroupRequestSchema,
  UpdateStoreRequestSchema,
  type CreateStoreGroupRequest,
  type CreateStoreRequest,
  type ListStoreGroupsQuery,
  type ListStoresQuery,
  type Store,
  type StoreGroup,
  type StoreGroupStatus,
  type StoreKind,
  type StoreStatus,
  type UpdateStoreGroupRequest,
  type UpdateStoreRequest,
} from '@idosi/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Layers3, Pencil, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { AdminAccess } from './AdminAccess';
import {
  AdminApiError,
  adminErrorMessage,
  createAdminStore,
  createAdminStoreGroup,
  listAdminStoreGroupDirectory,
  listAdminStoreGroups,
  listAdminStores,
  updateAdminStore,
  updateAdminStoreGroup,
} from './adminApi';
import './stores.css';

const groupQueryKey = ['admin', 'store-groups'] as const;
const storeQueryKey = ['admin', 'stores'] as const;
const auditQueryKey = ['admin', 'audit-logs'] as const;
const dependentStoreQueryKeys = [
  ['admin', 'active-stores'],
  ['admin', 'active-retail-store-choices'],
  ['dashboard', 'bootstrap'],
  ['stores', 'accessible'],
  ['store-transfer-destinations'],
  ['store-kind'],
] as const;
const pageSize = 20;

const groupStatusLabel: Record<StoreGroupStatus, string> = {
  ACTIVE: 'Hoạt động',
  INACTIVE: 'Ngừng hoạt động',
};

const storeStatusLabel: Record<StoreStatus, string> = {
  ACTIVE: 'Hoạt động',
  INACTIVE: 'Ngừng hoạt động',
};

const kindLabel: Record<StoreKind, string> = {
  RETAIL: 'Bán lẻ',
  WHOLESALE: 'Bán sỉ',
};

function confirmGroupDeactivation(group: StoreGroup): boolean {
  return window.confirm(
    `Ngừng nhóm ${group.code}? Các cửa hàng đang hoạt động phải được chuyển hoặc ngừng trước.`,
  );
}

function confirmStoreDeactivation(store: Store): boolean {
  return window.confirm(
    `Ngừng cửa hàng ${store.code}? Các thao tác bán lẻ sẽ bị chặn ngay lập tức.`,
  );
}

export interface StoreGroupFilters {
  readonly search: string;
  readonly status: '' | StoreGroupStatus;
}

export interface StoreFilters {
  readonly groupId: string;
  readonly kind: '' | StoreKind;
  readonly search: string;
  readonly status: '' | StoreStatus;
}

export interface StoreGroupDraft {
  readonly code: string;
  readonly name: string;
  readonly status: StoreGroupStatus;
}

export interface StoreDraft {
  readonly address: string;
  readonly code: string;
  readonly groupId: string;
  readonly kind: StoreKind;
  readonly name: string;
  readonly status: StoreStatus;
}

type EditorTarget =
  | { readonly kind: 'CREATE_GROUP' }
  | { readonly group: StoreGroup; readonly kind: 'EDIT_GROUP' }
  | { readonly kind: 'CREATE_STORE' }
  | { readonly kind: 'EDIT_STORE'; readonly store: Store };

interface Notice {
  readonly message: string;
  readonly tone: 'error' | 'success';
}

const emptyGroupFilters: StoreGroupFilters = { search: '', status: '' };
const emptyStoreFilters: StoreFilters = { groupId: '', kind: '', search: '', status: '' };

export function storeGroupQueryFromFilters(
  filters: StoreGroupFilters,
  page: number,
): ListStoreGroupsQuery {
  return {
    page,
    pageSize,
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

export function storeQueryFromFilters(filters: StoreFilters, page: number): ListStoresQuery {
  return {
    page,
    pageSize,
    ...(filters.groupId ? { groupId: filters.groupId } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

export function createStoreGroupInputFromDraft(draft: StoreGroupDraft): {
  readonly error: string | null;
  readonly input: CreateStoreGroupRequest | null;
} {
  const parsed = CreateStoreGroupRequestSchema.safeParse({
    code: draft.code.trim(),
    name: draft.name.trim(),
  });
  return parsed.success
    ? { error: null, input: parsed.data }
    : { error: 'Mã và tên nhóm cửa hàng không được để trống.', input: null };
}

export function updateStoreGroupInputFromDraft(
  group: StoreGroup,
  draft: StoreGroupDraft,
): { readonly error: string | null; readonly input: UpdateStoreGroupRequest | null } {
  const name = draft.name.trim();
  if (name === group.name && draft.status === group.status) {
    return { error: 'Chưa có thay đổi nào để lưu.', input: null };
  }
  const parsed = UpdateStoreGroupRequestSchema.safeParse({
    expectedVersion: group.version,
    ...(name === group.name ? {} : { name }),
    ...(draft.status === group.status ? {} : { status: draft.status }),
  });
  return parsed.success
    ? { error: null, input: parsed.data }
    : { error: 'Thông tin nhóm cửa hàng chưa hợp lệ.', input: null };
}

export function createStoreInputFromDraft(draft: StoreDraft): {
  readonly error: string | null;
  readonly input: CreateStoreRequest | null;
} {
  const parsed = CreateStoreRequestSchema.safeParse({
    address: draft.address.trim() || null,
    code: draft.code.trim(),
    groupId: draft.groupId,
    kind: draft.kind,
    name: draft.name.trim(),
  });
  return parsed.success
    ? { error: null, input: parsed.data }
    : { error: 'Hãy nhập đủ mã, tên và chọn nhóm cửa hàng đang hoạt động.', input: null };
}

export function updateStoreInputFromDraft(
  store: Store,
  draft: StoreDraft,
): { readonly error: string | null; readonly input: UpdateStoreRequest | null } {
  const address = draft.address.trim() || null;
  const name = draft.name.trim();
  const parsed = UpdateStoreRequestSchema.safeParse({
    expectedVersion: store.version,
    ...(address === store.address ? {} : { address }),
    ...(draft.groupId === store.groupId ? {} : { groupId: draft.groupId }),
    ...(draft.kind === store.kind ? {} : { kind: draft.kind }),
    ...(name === store.name ? {} : { name }),
    ...(draft.status === store.status ? {} : { status: draft.status }),
  });
  if (!parsed.success) {
    const changed =
      address !== store.address ||
      draft.groupId !== store.groupId ||
      draft.kind !== store.kind ||
      name !== store.name ||
      draft.status !== store.status;
    return {
      error: changed ? 'Thông tin cửa hàng chưa hợp lệ.' : 'Chưa có thay đổi nào để lưu.',
      input: null,
    };
  }
  return { error: null, input: parsed.data };
}

export function AdminStoresPage() {
  return (
    <AdminAccess>
      <AdminStoresContent />
    </AdminAccess>
  );
}

function AdminStoresContent() {
  const queryClient = useQueryClient();
  const [groupFilterDraft, setGroupFilterDraft] = useState<StoreGroupFilters>(emptyGroupFilters);
  const [groupFilters, setGroupFilters] = useState<StoreGroupFilters>(emptyGroupFilters);
  const [storeFilterDraft, setStoreFilterDraft] = useState<StoreFilters>(emptyStoreFilters);
  const [storeFilters, setStoreFilters] = useState<StoreFilters>(emptyStoreFilters);
  const [groupPage, setGroupPage] = useState(1);
  const [storePage, setStorePage] = useState(1);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mutationLock = useRef(false);
  const idempotencyKeys = useRef(new Map<string, string>());

  const groupsQuery = useQuery({
    queryFn: () => listAdminStoreGroups(storeGroupQueryFromFilters(groupFilters, groupPage)),
    queryKey: [...groupQueryKey, 'page', groupFilters, groupPage],
    retry: false,
  });
  const storesQuery = useQuery({
    queryFn: () => listAdminStores(storeQueryFromFilters(storeFilters, storePage)),
    queryKey: [...storeQueryKey, 'page', storeFilters, storePage],
    retry: false,
  });
  const allGroupsQuery = useQuery({
    queryFn: listAdminStoreGroupDirectory,
    queryKey: [...groupQueryKey, 'directory'],
    retry: false,
    staleTime: 30_000,
  });

  const groupsById = useMemo(
    () => new Map((allGroupsQuery.data ?? []).map((group) => [group.id, group] as const)),
    [allGroupsQuery.data],
  );
  const activeGroups = useMemo(
    () => (allGroupsQuery.data ?? []).filter((group) => group.status === 'ACTIVE'),
    [allGroupsQuery.data],
  );

  const refreshLifecycle = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: groupQueryKey }),
      queryClient.invalidateQueries({ queryKey: storeQueryKey }),
      queryClient.invalidateQueries({ queryKey: auditQueryKey }),
      ...dependentStoreQueryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ]);
  };

  const mutationKey = (fingerprint: string) => {
    const retained = idempotencyKeys.current.get(fingerprint);
    if (retained) return retained;
    const created = crypto.randomUUID();
    idempotencyKeys.current.set(fingerprint, created);
    return created;
  };

  const finishMutation = async (fingerprint: string, message: string, closeEditor: boolean) => {
    idempotencyKeys.current.delete(fingerprint);
    if (closeEditor) setEditor(null);
    setNotice({ message, tone: 'success' });
    await refreshLifecycle();
  };

  const failMutation = async (fingerprint: string, error: unknown, closeEditor: boolean) => {
    setNotice({ message: adminErrorMessage(error), tone: 'error' });
    if (error instanceof AdminApiError && error.code === 'VERSION_CONFLICT') {
      idempotencyKeys.current.delete(fingerprint);
      if (closeEditor) setEditor(null);
      await refreshLifecycle();
    }
  };

  const runMutation = async (
    action: string,
    fingerprint: string,
    operation: (key: string) => Promise<string>,
    closeEditor = false,
  ) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusyAction(action);
    setNotice(null);
    try {
      await finishMutation(fingerprint, await operation(mutationKey(fingerprint)), closeEditor);
    } catch (error) {
      await failMutation(fingerprint, error, closeEditor);
    } finally {
      mutationLock.current = false;
      setBusyAction(null);
    }
  };

  const saveGroup = async (draft: StoreGroupDraft, group?: StoreGroup) => {
    const parsed = group
      ? updateStoreGroupInputFromDraft(group, draft)
      : createStoreGroupInputFromDraft(draft);
    if (!parsed.input) {
      setNotice({ message: parsed.error ?? 'Thông tin nhóm chưa hợp lệ.', tone: 'error' });
      return;
    }
    if (
      group?.status === 'ACTIVE' &&
      (parsed.input as UpdateStoreGroupRequest).status === 'INACTIVE' &&
      !confirmGroupDeactivation(group)
    ) {
      return;
    }
    const fingerprint = JSON.stringify({ groupId: group?.id ?? null, input: parsed.input });
    await runMutation(
      group ? `group:${group.id}` : 'group:create',
      fingerprint,
      async (key) => {
        const saved = group
          ? await updateAdminStoreGroup(group.id, parsed.input as UpdateStoreGroupRequest, key)
          : await createAdminStoreGroup(parsed.input as CreateStoreGroupRequest, key);
        return group
          ? `Đã cập nhật nhóm ${saved.code} lên phiên bản ${saved.version}.`
          : `Đã tạo nhóm ${saved.code}.`;
      },
      true,
    );
  };

  const saveStore = async (draft: StoreDraft, store?: Store) => {
    const parsed = store
      ? updateStoreInputFromDraft(store, draft)
      : createStoreInputFromDraft(draft);
    if (!parsed.input) {
      setNotice({ message: parsed.error ?? 'Thông tin cửa hàng chưa hợp lệ.', tone: 'error' });
      return;
    }
    if (
      store?.status === 'ACTIVE' &&
      (parsed.input as UpdateStoreRequest).status === 'INACTIVE' &&
      !confirmStoreDeactivation(store)
    ) {
      return;
    }
    const fingerprint = JSON.stringify({ input: parsed.input, storeId: store?.id ?? null });
    await runMutation(
      store ? `store:${store.id}` : 'store:create',
      fingerprint,
      async (key) => {
        const saved = store
          ? await updateAdminStore(store.id, parsed.input as UpdateStoreRequest, key)
          : await createAdminStore(parsed.input as CreateStoreRequest, key);
        return store
          ? `Đã cập nhật cửa hàng ${saved.code} lên phiên bản ${saved.version}.`
          : `Đã tạo cửa hàng ${saved.code}.`;
      },
      true,
    );
  };

  const changeGroupStatus = async (group: StoreGroup) => {
    const status: StoreGroupStatus = group.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (status === 'INACTIVE' && !confirmGroupDeactivation(group)) {
      return;
    }
    const input: UpdateStoreGroupRequest = { expectedVersion: group.version, status };
    const fingerprint = JSON.stringify({ groupId: group.id, input });
    await runMutation(`group:${group.id}`, fingerprint, async (key) => {
      const updated = await updateAdminStoreGroup(group.id, input, key);
      return `Nhóm ${updated.code}: ${groupStatusLabel[updated.status].toLocaleLowerCase('vi-VN')}.`;
    });
  };

  const changeStoreStatus = async (store: Store) => {
    const status: StoreStatus = store.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (status === 'INACTIVE' && !confirmStoreDeactivation(store)) {
      return;
    }
    const input: UpdateStoreRequest = { expectedVersion: store.version, status };
    const fingerprint = JSON.stringify({ input, storeId: store.id });
    await runMutation(`store:${store.id}`, fingerprint, async (key) => {
      const updated = await updateAdminStore(store.id, input, key);
      return `Cửa hàng ${updated.code}: ${storeStatusLabel[updated.status].toLocaleLowerCase('vi-VN')}.`;
    });
  };

  const submitGroupFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setGroupPage(1);
    setGroupFilters({ ...groupFilterDraft });
  };

  const submitStoreFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStorePage(1);
    setStoreFilters({ ...storeFilterDraft });
  };

  const groups = groupsQuery.data?.data ?? [];
  const stores = storesQuery.data?.data ?? [];
  const busy = busyAction !== null;

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button
              className="admin-clickable store-lifecycle-add-group"
              disabled={busy}
              onClick={() => {
                setNotice(null);
                setEditor({ kind: 'CREATE_GROUP' });
              }}
              tone="secondary"
            >
              <Plus aria-hidden="true" size={16} /> Thêm nhóm
            </Button>
            <Button
              className="admin-clickable"
              disabled={busy || activeGroups.length === 0}
              onClick={() => {
                setNotice(null);
                setEditor({ kind: 'CREATE_STORE' });
              }}
            >
              <Plus aria-hidden="true" size={16} /> Thêm cửa hàng
            </Button>
          </>
        }
        description="Quản lý nhóm, cửa hàng, loại hình và trạng thái bằng dữ liệu PostgreSQL có version"
        title="Cửa hàng & nhóm"
      />

      <section className="admin-security-note">
        <ShieldCheck aria-hidden="true" size={22} />
        <div>
          <strong>Chống ghi đè và thao tác lặp</strong>
          <span>
            Mỗi cập nhật gửi đúng version hiện tại; retry mạng giữ nguyên idempotency key và mọi
            thay đổi đều có audit.
          </span>
        </div>
      </section>

      {editor?.kind === 'CREATE_GROUP' || editor?.kind === 'EDIT_GROUP' ? (
        <StoreGroupEditor
          busy={busy}
          key={editor.kind === 'EDIT_GROUP' ? editor.group.id : 'create-group'}
          onCancel={() => {
            if (!busy) setEditor(null);
          }}
          onSave={saveGroup}
          {...(editor.kind === 'EDIT_GROUP' ? { group: editor.group } : {})}
        />
      ) : null}
      {editor?.kind === 'CREATE_STORE' || editor?.kind === 'EDIT_STORE' ? (
        <StoreEditor
          allGroups={allGroupsQuery.data ?? []}
          busy={busy}
          key={editor.kind === 'EDIT_STORE' ? editor.store.id : 'create-store'}
          onCancel={() => {
            if (!busy) setEditor(null);
          }}
          onSave={saveStore}
          {...(editor.kind === 'EDIT_STORE' ? { store: editor.store } : {})}
        />
      ) : null}

      <div aria-live="polite" className="admin-announcer">
        {notice ? (
          <p
            className={`admin-feedback admin-feedback--${notice.tone}`}
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            {notice.message}
          </p>
        ) : null}
      </div>

      {allGroupsQuery.isError ? (
        <LifecycleLoadError
          error={allGroupsQuery.error}
          onRetry={() => void allGroupsQuery.refetch()}
        />
      ) : null}

      <div className="store-lifecycle-summary" aria-label="Tóm tắt danh mục cửa hàng">
        <span>
          <Layers3 aria-hidden="true" size={18} />
          <strong>{allGroupsQuery.data?.length ?? '—'}</strong> nhóm
        </span>
        <span>
          <Building2 aria-hidden="true" size={18} />
          <strong>{storesQuery.data?.pagination.totalItems ?? '—'}</strong> cửa hàng theo bộ lọc
        </span>
      </div>

      <section className="admin-panel" aria-labelledby="store-groups-heading">
        <LifecycleHeading
          description="Vô hiệu hóa nhóm chỉ khi không còn cửa hàng đang hoạt động."
          onRefresh={() => {
            void Promise.all([groupsQuery.refetch(), allGroupsQuery.refetch()]);
          }}
          refreshing={groupsQuery.isFetching || allGroupsQuery.isFetching}
          title="Nhóm cửa hàng"
        />
        <form className="store-lifecycle-filters" onSubmit={submitGroupFilters}>
          <SearchField
            label="Tìm nhóm"
            onChange={(search) => setGroupFilterDraft((current) => ({ ...current, search }))}
            placeholder="Mã hoặc tên nhóm"
            value={groupFilterDraft.search}
          />
          <label className="admin-field">
            <span>Trạng thái</span>
            <select
              onChange={(event) =>
                setGroupFilterDraft((current) => ({
                  ...current,
                  status: event.target.value as StoreGroupFilters['status'],
                }))
              }
              value={groupFilterDraft.status}
            >
              <option value="">Tất cả</option>
              <option value="ACTIVE">Hoạt động</option>
              <option value="INACTIVE">Ngừng hoạt động</option>
            </select>
          </label>
          <FilterActions
            busy={groupsQuery.isFetching}
            onClear={() => {
              setGroupFilterDraft(emptyGroupFilters);
              setGroupFilters(emptyGroupFilters);
              setGroupPage(1);
            }}
          />
        </form>
        {groupsQuery.isPending ? <LifecycleLoading label="Đang tải nhóm cửa hàng…" /> : null}
        {groupsQuery.isError ? (
          <LifecycleLoadError
            error={groupsQuery.error}
            onRetry={() => void groupsQuery.refetch()}
          />
        ) : null}
        {groupsQuery.isSuccess && groups.length === 0 ? (
          <EmptyState detail="Thử đổi bộ lọc hoặc tạo nhóm mới." title="Không có nhóm phù hợp" />
        ) : null}
        {groups.length > 0 ? (
          <StoreGroupTable
            busyAction={busyAction}
            groups={groups}
            onEdit={(group) => {
              setNotice(null);
              setEditor({ group, kind: 'EDIT_GROUP' });
            }}
            onStatus={changeGroupStatus}
          />
        ) : null}
        <Pagination
          currentPage={groupPage}
          label="nhóm"
          onPage={setGroupPage}
          pagination={groupsQuery.data?.pagination}
          refreshing={groupsQuery.isFetching}
        />
      </section>

      <section className="admin-panel" aria-labelledby="stores-heading">
        <LifecycleHeading
          description="Cửa hàng hoạt động phải luôn thuộc một nhóm đang hoạt động."
          onRefresh={() => void storesQuery.refetch()}
          refreshing={storesQuery.isFetching}
          title="Cửa hàng"
        />
        <form
          className="store-lifecycle-filters store-lifecycle-filters--stores"
          onSubmit={submitStoreFilters}
        >
          <SearchField
            label="Tìm cửa hàng"
            onChange={(search) => setStoreFilterDraft((current) => ({ ...current, search }))}
            placeholder="Mã hoặc tên cửa hàng"
            value={storeFilterDraft.search}
          />
          <label className="admin-field">
            <span>Nhóm</span>
            <select
              onChange={(event) =>
                setStoreFilterDraft((current) => ({ ...current, groupId: event.target.value }))
              }
              value={storeFilterDraft.groupId}
            >
              <option value="">Tất cả</option>
              {(allGroupsQuery.data ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.code} · {group.name}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-field">
            <span>Loại hình</span>
            <select
              onChange={(event) =>
                setStoreFilterDraft((current) => ({
                  ...current,
                  kind: event.target.value as StoreFilters['kind'],
                }))
              }
              value={storeFilterDraft.kind}
            >
              <option value="">Tất cả</option>
              <option value="RETAIL">Bán lẻ</option>
              <option value="WHOLESALE">Bán sỉ</option>
            </select>
          </label>
          <label className="admin-field">
            <span>Trạng thái</span>
            <select
              onChange={(event) =>
                setStoreFilterDraft((current) => ({
                  ...current,
                  status: event.target.value as StoreFilters['status'],
                }))
              }
              value={storeFilterDraft.status}
            >
              <option value="">Tất cả</option>
              <option value="ACTIVE">Hoạt động</option>
              <option value="INACTIVE">Ngừng hoạt động</option>
            </select>
          </label>
          <FilterActions
            busy={storesQuery.isFetching}
            onClear={() => {
              setStoreFilterDraft(emptyStoreFilters);
              setStoreFilters(emptyStoreFilters);
              setStorePage(1);
            }}
          />
        </form>
        {storesQuery.isPending ? <LifecycleLoading label="Đang tải cửa hàng…" /> : null}
        {storesQuery.isError ? (
          <LifecycleLoadError
            error={storesQuery.error}
            onRetry={() => void storesQuery.refetch()}
          />
        ) : null}
        {storesQuery.isSuccess && stores.length === 0 ? (
          <EmptyState
            detail="Thử đổi bộ lọc hoặc tạo cửa hàng mới."
            title="Không có cửa hàng phù hợp"
          />
        ) : null}
        {stores.length > 0 ? (
          <StoreTable
            busyAction={busyAction}
            groupsById={groupsById}
            onEdit={(store) => {
              setNotice(null);
              setEditor({ kind: 'EDIT_STORE', store });
            }}
            onStatus={changeStoreStatus}
            stores={stores}
          />
        ) : null}
        <Pagination
          currentPage={storePage}
          label="cửa hàng"
          onPage={setStorePage}
          pagination={storesQuery.data?.pagination}
          refreshing={storesQuery.isFetching}
        />
      </section>
    </>
  );
}

function StoreGroupEditor({
  busy,
  group,
  onCancel,
  onSave,
}: {
  readonly busy: boolean;
  readonly group?: StoreGroup;
  readonly onCancel: () => void;
  readonly onSave: (draft: StoreGroupDraft, group?: StoreGroup) => Promise<void>;
}) {
  const [draft, setDraft] = useState<StoreGroupDraft>({
    code: group?.code ?? '',
    name: group?.name ?? '',
    status: group?.status ?? 'ACTIVE',
  });
  const deactivating = group?.status === 'ACTIVE' && draft.status === 'INACTIVE';
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave(draft, group);
  };
  return (
    <section className="admin-panel admin-editor" id="store-group-editor">
      <EditorHeading
        busy={busy}
        description={
          group
            ? `Mã ${group.code} là bất biến; thay đổi dùng phiên bản ${group.version}.`
            : 'Nhóm mới được kích hoạt ngay sau khi backend ghi thành công.'
        }
        onCancel={onCancel}
        title={group ? `Sửa nhóm ${group.code}` : 'Tạo nhóm cửa hàng'}
      />
      <form className="admin-form-grid" onSubmit={submit}>
        <label className="admin-field">
          <span className="field-label">Mã nhóm</span>
          <input
            autoFocus={!group}
            disabled={busy || Boolean(group)}
            maxLength={40}
            onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))}
            required
            value={draft.code}
          />
        </label>
        <label className="admin-field">
          <span className="field-label">Tên nhóm</span>
          <input
            autoFocus={Boolean(group)}
            disabled={busy}
            maxLength={120}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            required
            value={draft.name}
          />
        </label>
        {group ? (
          <label className="admin-field">
            <span>Trạng thái</span>
            <select
              disabled={busy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  status: event.target.value as StoreGroupStatus,
                }))
              }
              value={draft.status}
            >
              <option value="ACTIVE">Hoạt động</option>
              <option value="INACTIVE">Ngừng hoạt động</option>
            </select>
          </label>
        ) : null}
        <div className="admin-form-actions">
          <Button disabled={busy} onClick={onCancel} tone="secondary">
            Hủy
          </Button>
          <Button
            busy={busy}
            className="admin-clickable"
            tone={deactivating ? 'danger' : 'primary'}
            type="submit"
          >
            {deactivating ? 'Xác nhận ngừng' : group ? 'Lưu thay đổi' : 'Tạo nhóm'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function StoreEditor({
  allGroups,
  busy,
  onCancel,
  onSave,
  store,
}: {
  readonly allGroups: readonly StoreGroup[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: StoreDraft, store?: Store) => Promise<void>;
  readonly store?: Store;
}) {
  const firstActiveGroup = allGroups.find((group) => group.status === 'ACTIVE');
  const [draft, setDraft] = useState<StoreDraft>({
    address: store?.address ?? '',
    code: store?.code ?? '',
    groupId: store?.groupId ?? firstActiveGroup?.id ?? '',
    kind: store?.kind ?? 'RETAIL',
    name: store?.name ?? '',
    status: store?.status ?? 'ACTIVE',
  });
  const deactivating = store?.status === 'ACTIVE' && draft.status === 'INACTIVE';
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void onSave(draft, store);
  };
  return (
    <section className="admin-panel admin-editor" id="store-editor">
      <EditorHeading
        busy={busy}
        description={
          store
            ? `Mã ${store.code} là bất biến; thay đổi dùng phiên bản ${store.version}.`
            : 'Cửa hàng mới được kích hoạt và ghi audit sau khi backend xác nhận.'
        }
        onCancel={onCancel}
        title={store ? `Sửa cửa hàng ${store.code}` : 'Tạo cửa hàng'}
      />
      <form className="admin-form-grid" onSubmit={submit}>
        <label className="admin-field">
          <span className="field-label">Mã cửa hàng</span>
          <input
            autoFocus={!store}
            disabled={busy || Boolean(store)}
            maxLength={40}
            onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))}
            required
            value={draft.code}
          />
        </label>
        <label className="admin-field">
          <span className="field-label">Tên cửa hàng</span>
          <input
            autoFocus={Boolean(store)}
            disabled={busy}
            maxLength={160}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            required
            value={draft.name}
          />
        </label>
        <label className="admin-field">
          <span className="field-label">Nhóm cửa hàng</span>
          <select
            disabled={busy}
            onChange={(event) =>
              setDraft((current) => ({ ...current, groupId: event.target.value }))
            }
            required
            value={draft.groupId}
          >
            <option disabled value="">
              Chọn nhóm đang hoạt động
            </option>
            {allGroups.map((group) => {
              const disabled = group.status !== 'ACTIVE' && group.id !== store?.groupId;
              return (
                <option disabled={disabled} key={group.id} value={group.id}>
                  {group.code} · {group.name}
                  {group.status === 'INACTIVE' ? ' (ngừng hoạt động)' : ''}
                </option>
              );
            })}
          </select>
        </label>
        <label className="admin-field">
          <span>Loại hình</span>
          <select
            disabled={busy}
            onChange={(event) =>
              setDraft((current) => ({ ...current, kind: event.target.value as StoreKind }))
            }
            value={draft.kind}
          >
            <option value="RETAIL">Bán lẻ</option>
            <option value="WHOLESALE">Bán sỉ</option>
          </select>
        </label>
        <label className="admin-field admin-field--wide">
          <span>Địa chỉ</span>
          <input
            disabled={busy}
            maxLength={500}
            onChange={(event) =>
              setDraft((current) => ({ ...current, address: event.target.value }))
            }
            placeholder="Để trống nếu chưa cập nhật"
            value={draft.address}
          />
        </label>
        {store ? (
          <label className="admin-field">
            <span>Trạng thái</span>
            <select
              disabled={busy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  status: event.target.value as StoreStatus,
                }))
              }
              value={draft.status}
            >
              <option value="ACTIVE">Hoạt động</option>
              <option value="INACTIVE">Ngừng hoạt động</option>
            </select>
          </label>
        ) : null}
        <div className="admin-form-actions">
          <Button disabled={busy} onClick={onCancel} tone="secondary">
            Hủy
          </Button>
          <Button
            busy={busy}
            className="admin-clickable"
            tone={deactivating ? 'danger' : 'primary'}
            type="submit"
          >
            {deactivating ? 'Xác nhận ngừng' : store ? 'Lưu thay đổi' : 'Tạo cửa hàng'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function StoreGroupTable({
  busyAction,
  groups,
  onEdit,
  onStatus,
}: {
  readonly busyAction: string | null;
  readonly groups: readonly StoreGroup[];
  readonly onEdit: (group: StoreGroup) => void;
  readonly onStatus: (group: StoreGroup) => Promise<void>;
}) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table store-lifecycle-table">
        <caption className="admin-sr-only">Danh sách nhóm cửa hàng</caption>
        <thead>
          <tr>
            <th scope="col">Nhóm</th>
            <th scope="col">Trạng thái</th>
            <th scope="col">Phiên bản</th>
            <th scope="col">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const rowBusy = busyAction === `group:${group.id}`;
            return (
              <tr key={group.id}>
                <td data-label="Nhóm">
                  <strong>{group.name}</strong>
                  <small>{group.code}</small>
                </td>
                <td data-label="Trạng thái">
                  <Badge tone={group.status === 'ACTIVE' ? 'success' : 'danger'}>
                    {groupStatusLabel[group.status]}
                  </Badge>
                </td>
                <td data-label="Phiên bản">v{group.version}</td>
                <td data-label="Thao tác">
                  <div className="admin-row-actions">
                    <button
                      aria-label={`Chỉnh sửa nhóm ${group.code}`}
                      className="admin-action admin-action--secondary"
                      disabled={busyAction !== null}
                      onClick={() => onEdit(group)}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={15} /> Sửa
                    </button>
                    <button
                      aria-label={`${group.status === 'ACTIVE' ? 'Ngừng' : 'Kích hoạt'} nhóm ${group.code}`}
                      aria-busy={rowBusy}
                      className={
                        group.status === 'ACTIVE'
                          ? 'admin-action admin-action--danger'
                          : 'admin-action'
                      }
                      disabled={busyAction !== null}
                      onClick={() => void onStatus(group)}
                      type="button"
                    >
                      {rowBusy ? <span aria-hidden="true" className="admin-mini-spinner" /> : null}
                      {group.status === 'ACTIVE' ? 'Ngừng nhóm' : 'Kích hoạt nhóm'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StoreTable({
  busyAction,
  groupsById,
  onEdit,
  onStatus,
  stores,
}: {
  readonly busyAction: string | null;
  readonly groupsById: ReadonlyMap<string, StoreGroup>;
  readonly onEdit: (store: Store) => void;
  readonly onStatus: (store: Store) => Promise<void>;
  readonly stores: readonly Store[];
}) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table store-lifecycle-table store-lifecycle-table--stores">
        <caption className="admin-sr-only">Danh sách cửa hàng</caption>
        <thead>
          <tr>
            <th scope="col">Cửa hàng</th>
            <th scope="col">Nhóm / loại hình</th>
            <th scope="col">Trạng thái</th>
            <th scope="col">Phiên bản</th>
            <th scope="col">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => {
            const group = groupsById.get(store.groupId);
            const rowBusy = busyAction === `store:${store.id}`;
            return (
              <tr key={store.id}>
                <td data-label="Cửa hàng">
                  <strong>{store.name}</strong>
                  <small>
                    {store.code}
                    {store.address ? ` · ${store.address}` : ''}
                  </small>
                </td>
                <td data-label="Nhóm / loại">
                  <strong>{group ? group.name : 'Nhóm chưa tải'}</strong>
                  <small>{kindLabel[store.kind]}</small>
                </td>
                <td data-label="Trạng thái">
                  <Badge tone={store.status === 'ACTIVE' ? 'success' : 'danger'}>
                    {storeStatusLabel[store.status]}
                  </Badge>
                </td>
                <td data-label="Phiên bản">v{store.version}</td>
                <td data-label="Thao tác">
                  <div className="admin-row-actions">
                    <button
                      aria-label={`Chỉnh sửa cửa hàng ${store.code}`}
                      className="admin-action admin-action--secondary"
                      disabled={busyAction !== null}
                      onClick={() => onEdit(store)}
                      type="button"
                    >
                      <Pencil aria-hidden="true" size={15} /> Sửa
                    </button>
                    <button
                      aria-label={`${store.status === 'ACTIVE' ? 'Ngừng' : 'Kích hoạt'} cửa hàng ${store.code}`}
                      aria-busy={rowBusy}
                      className={
                        store.status === 'ACTIVE'
                          ? 'admin-action admin-action--danger'
                          : 'admin-action'
                      }
                      disabled={busyAction !== null}
                      onClick={() => void onStatus(store)}
                      type="button"
                    >
                      {rowBusy ? <span aria-hidden="true" className="admin-mini-spinner" /> : null}
                      {store.status === 'ACTIVE' ? 'Ngừng cửa hàng' : 'Kích hoạt cửa hàng'}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LifecycleHeading({
  description,
  onRefresh,
  refreshing,
  title,
}: {
  readonly description: string;
  readonly onRefresh: () => void;
  readonly refreshing: boolean;
  readonly title: string;
}) {
  const headingId = title === 'Nhóm cửa hàng' ? 'store-groups-heading' : 'stores-heading';
  return (
    <div className="store-lifecycle-heading">
      <div>
        <h2 id={headingId}>{title}</h2>
        <p>{description}</p>
      </div>
      <Button busy={refreshing} onClick={onRefresh} tone="secondary">
        <RefreshCw aria-hidden="true" size={15} /> Tải lại
      </Button>
    </div>
  );
}

function EditorHeading({
  busy,
  description,
  onCancel,
  title,
}: {
  readonly busy: boolean;
  readonly description: string;
  readonly onCancel: () => void;
  readonly title: string;
}) {
  return (
    <div className="admin-section-heading">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <button
        aria-label="Đóng biểu mẫu"
        className="admin-icon-button"
        disabled={busy}
        onClick={onCancel}
        type="button"
      >
        <X aria-hidden="true" size={18} />
      </button>
    </div>
  );
}

function SearchField({
  label,
  onChange,
  placeholder,
  value,
}: {
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly placeholder: string;
  readonly value: string;
}) {
  return (
    <label className="admin-field admin-field--search">
      <span>{label}</span>
      <span className="admin-input-with-icon">
        <Search aria-hidden="true" size={16} />
        <input
          maxLength={160}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          value={value}
        />
      </span>
    </label>
  );
}

function FilterActions({
  busy,
  onClear,
}: {
  readonly busy: boolean;
  readonly onClear: () => void;
}) {
  return (
    <div className="admin-form-actions admin-form-actions--filters">
      <Button busy={busy} className="admin-clickable" type="submit">
        Lọc
      </Button>
      <Button className="admin-clickable" disabled={busy} onClick={onClear} tone="secondary">
        Xóa lọc
      </Button>
    </div>
  );
}

function Pagination({
  currentPage,
  label,
  onPage,
  pagination,
  refreshing,
}: {
  readonly currentPage: number;
  readonly label: string;
  readonly onPage: (page: number) => void;
  readonly pagination:
    { readonly page: number; readonly totalItems: number; readonly totalPages: number } | undefined;
  readonly refreshing: boolean;
}) {
  if (!pagination || (pagination.totalPages <= 1 && currentPage <= 1)) return null;
  const lastPage = Math.max(1, pagination.totalPages);
  return (
    <nav aria-label={`Phân trang ${label}`} className="admin-pagination">
      <button
        className="admin-action"
        disabled={currentPage <= 1 || refreshing}
        onClick={() => onPage(Math.max(1, currentPage - 1))}
        type="button"
      >
        Trang trước
      </button>
      <span>
        Trang {currentPage}/{lastPage} · {pagination.totalItems} {label}
      </span>
      <button
        className="admin-action"
        disabled={currentPage >= lastPage || refreshing}
        onClick={() => onPage(currentPage + 1)}
        type="button"
      >
        Trang sau
      </button>
    </nav>
  );
}

function LifecycleLoading({ label }: { readonly label: string }) {
  return (
    <section aria-live="polite" className="admin-state" role="status">
      <span aria-hidden="true" className="admin-spinner" />
      <strong>{label}</strong>
    </section>
  );
}

function LifecycleLoadError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  return (
    <section className="admin-state admin-state--error" role="alert">
      <strong>Không thể tải dữ liệu</strong>
      <p>{adminErrorMessage(error)}</p>
      <Button onClick={onRetry}>Thử lại</Button>
    </section>
  );
}
