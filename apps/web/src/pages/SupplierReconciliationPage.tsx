import { useOutletContext, useSearchParams } from 'react-router-dom';

import type { AppOutletContext } from '../components/AppShell';
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
import { SupplierOrdersPanel } from '../features/supplier-reconciliation/SupplierOrdersPanel';
import '../features/supplier-reconciliation/supplier-reconciliation.css';

const DESCRIPTION: Record<AppOutletContext['role'], string> = {
  ADMIN:
    'Nhập tổng tồn Reshare đang cho đặt; hệ thống tự trừ phần IDOSI đã giữ/cấp nhưng chưa đặt và chỉ phân bổ phần còn lại.',
  HTKD: 'Ghi nhận đúng số bao Reshare đã nhận cho các kết quả phân bổ của cửa hàng được phân công.',
  STORE: 'Theo dõi hàng đã phân bổ cho cửa hàng đã được đặt bên Reshare hay chưa.',
  WHOLESALE: 'Theo dõi hàng đã phân bổ cho cửa hàng sỉ đã được đặt bên Reshare hay chưa.',
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
    return <UnavailableFeature title="Đối chiếu tồn Reshare" />;
  }

  return (
    <>
      <PageHeader title="Đối chiếu tồn Reshare" description={DESCRIPTION[role]} />
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
      <TabPanel idPrefix="supplier-reconciliation" tab={tab}>
        {tab === 'reconcile' ? (
          <ReconciliationWorkspace
            accountId={accountId}
            onOpenSettings={() => setTab('settings')}
          />
        ) : tab === 'orders' ? (
          <SupplierOrdersPanel accountId={accountId} />
        ) : tab === 'history' ? (
          <ObservationHistory accountId={accountId} />
        ) : tab === 'settings' ? (
          <SourceSettings accountId={accountId} />
        ) : (
          <SupplierOrdersPanel accountId={accountId} readOnly />
        )}
      </TabPanel>
    </>
  );
}
