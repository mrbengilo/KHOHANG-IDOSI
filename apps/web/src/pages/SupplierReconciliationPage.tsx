import { useOutletContext, useSearchParams } from 'react-router-dom';

import type { AppOutletContext } from '../components/AppShell';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { TabPanel, Tabs } from '../components/Tabs';
import { UnavailableFeature } from '../components/UnavailableFeature';
import { mockModeEnabled } from '../lib/api';
import { useSession } from '../lib/auth';
import {
  SUPPLIER_TAB_LABELS,
  readSupplierTab,
  supplierTabsFor,
  type SupplierTab,
} from '../features/supplier-reconciliation/model';
import { ObservationHistory } from '../features/supplier-reconciliation/ObservationHistory';
import { ReconciliationWorkspace } from '../features/supplier-reconciliation/ReconciliationWorkspace';
import { SourceSettings } from '../features/supplier-reconciliation/SourceSettings';
import { ReshareOrdersPanel } from '../features/supplier-reconciliation/ReshareOrdersPanel';
import { SupplierOrdersPanel } from '../features/supplier-reconciliation/SupplierOrdersPanel';
import '../features/supplier-reconciliation/supplier-reconciliation.css';

const DESCRIPTION =
  'Xác nhận kết quả phân bổ để tự tạo đơn Reshare và xuất kho IDOSI. Dùng đơn này để đặt hàng trên Reshare.';

const ROLE_HINT: Record<AppOutletContext['role'], string> = {
  ADMIN:
    'Admin xem đơn của mọi cửa hàng, cập nhật tổng tồn Reshare đang cho đặt và cấu hình nguồn.',
  HTKD: 'Đơn của các cửa hàng được phân công. Xác nhận kết quả phân bổ ở trang Phân bổ hàng hóa.',
  STORE: 'Đơn của cửa hàng. Xác nhận kết quả phân bổ ở trang Phân bổ hàng hóa.',
  WHOLESALE: 'Đơn của cửa hàng sỉ trong phạm vi. Xác nhận kết quả ở trang Phân bổ hàng hóa.',
};

export function SupplierReconciliationPage() {
  const { role } = useOutletContext<AppOutletContext>();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tab = readSupplierTab(params.get('tab'), role);
  const tabs = supplierTabsFor(role);
  const accountId = session.data?.principal.accountId ?? 'demo';
  const setTab = (next: SupplierTab) =>
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === tabs[0]) updated.delete('tab');
      else updated.set('tab', next);
      return updated;
    });

  if (mockModeEnabled) {
    return <UnavailableFeature title="Đơn đặt và tồn Reshare" />;
  }

  return (
    <>
      <PageHeader title="Đơn đặt và tồn Reshare" description={DESCRIPTION} />
      <p className="supplier-hint supplier-role-hint">{ROLE_HINT[role]}</p>
      {tabs.length > 1 ? (
        <Tabs
          active={tab}
          emphasis="prominent"
          idPrefix="supplier-reconciliation"
          items={tabs.map((id) => ({ id, label: SUPPLIER_TAB_LABELS[id] }))}
          label="Nội dung đối chiếu Reshare"
          onChange={setTab}
        />
      ) : null}
      <TabPanel idPrefix="supplier-reconciliation" tab={tabs.includes(tab) ? tab : tabs[0]!}>
        {tab === 'orders' ? (
          <>
            <ReshareOrdersPanel
              accountId={accountId}
              initialCode={params.get('code')?.slice(0, 20) ?? ''}
            />
            {role === 'ADMIN' || role === 'HTKD' ? (
              <div className="supplier-legacy-link">
                <p className="supplier-hint">
                  Đơn Reshare ghi nhận thủ công cho hàng giữ trước khi có đơn RE vẫn được lưu để tra
                  cứu.
                </p>
                <Button onClick={() => setTab('legacy')} tone="secondary">
                  Xem đơn ghi nhận thủ công
                </Button>
              </div>
            ) : null}
          </>
        ) : tab === 'reconcile' ? (
          <ReconciliationWorkspace
            accountId={accountId}
            onOpenSettings={() => setTab('settings')}
          />
        ) : tab === 'legacy' ? (
          <>
            <div className="supplier-legacy-link">
              <p className="supplier-hint">
                Dữ liệu cũ: đơn đặt trên Reshare được ghi nhận thủ công cho hàng giữ từ trước khi có
                đơn RE. Luồng mới không cần nhập mã đơn Reshare hay thời điểm Reshare nhận đơn.
              </p>
              <Button onClick={() => setTab('orders')} tone="secondary">
                Quay lại Đơn đặt Reshare
              </Button>
            </div>
            <SupplierOrdersPanel accountId={accountId} />
          </>
        ) : tab === 'history' ? (
          <ObservationHistory accountId={accountId} />
        ) : (
          <SourceSettings accountId={accountId} />
        )}
      </TabPanel>
    </>
  );
}
