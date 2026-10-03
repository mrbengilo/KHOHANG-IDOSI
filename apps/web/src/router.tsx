import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { DashboardSkeleton } from './components/Skeleton';

const InboundStatisticsPage = lazy(() =>
  import('./pages/InboundStatisticsPage').then((module) => ({
    default: module.InboundStatisticsPage,
  })),
);

const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const WarehouseInboundPage = lazy(() =>
  import('./pages/WarehouseInboundPage').then((module) => ({
    default: module.WarehouseInboundPage,
  })),
);
const AllocationPage = lazy(() =>
  import('./pages/AllocationPage').then((module) => ({ default: module.AllocationPage })),
);
const CatalogPage = lazy(() =>
  import('./pages/CatalogPage').then((module) => ({ default: module.CatalogPage })),
);
const RequestsPage = lazy(() =>
  import('./pages/RequestsPage').then((module) => ({ default: module.RequestsPage })),
);
const ReceivePage = lazy(() =>
  import('./pages/ReceivePage').then((module) => ({ default: module.ReceivePage })),
);
const PartnerInboundPage = lazy(() =>
  import('./pages/PartnerInboundPage').then((module) => ({
    default: module.PartnerInboundPage,
  })),
);
const InventoryPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.InventoryPage })),
);
const OpenBagPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.OpenBagPage })),
);
const SalesPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.SalesPage })),
);
const SortingPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.SortingPage })),
);
const TransfersPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.TransfersPage })),
);
const ReportsPage = lazy(() =>
  import('./pages/ReportsPage').then((module) => ({ default: module.ReportsPage })),
);
const UsersPage = lazy(() =>
  import('./features/admin/AdminUsersPage').then((module) => ({
    default: module.AdminUsersPage,
  })),
);
const StoresPage = lazy(() =>
  import('./features/admin/AdminStoresPage').then((module) => ({
    default: module.AdminStoresPage,
  })),
);
const AuditPage = lazy(() =>
  import('./features/admin/AuditLogPage').then((module) => ({ default: module.AuditLogPage })),
);
const SettingsPage = lazy(() =>
  import('./features/admin/AdminSettingsPage').then((module) => ({
    default: module.AdminSettingsPage,
  })),
);
const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((module) => ({ default: module.LoginPage })),
);
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })),
);

const suspense = (element: React.ReactNode) => (
  <Suspense fallback={<DashboardSkeleton />}>{element}</Suspense>
);

const pageError = <RouteErrorBoundary layout="page" />;

export const router = createBrowserRouter([
  { path: '/login', element: suspense(<LoginPage />), errorElement: pageError },
  {
    path: '/',
    element: <AppShell />,
    errorElement: pageError,
    children: [
      {
        // A failed screen (render error, chunk that could not load) stays inside the shell.
        errorElement: <RouteErrorBoundary layout="workspace" />,
        children: [
          { index: true, element: suspense(<DashboardPage />) },
          { path: 'allocations', element: suspense(<AllocationPage />) },
          { path: 'requests', element: suspense(<RequestsPage />) },
          { path: 'warehouse-inbound', element: suspense(<WarehouseInboundPage />) },
          { path: 'receive', element: suspense(<ReceivePage />) },
          { path: 'partner-inbound', element: suspense(<PartnerInboundPage />) },
          { path: 'inventory', element: suspense(<InventoryPage />) },
          { path: 'open-bag', element: suspense(<OpenBagPage />) },
          { path: 'sales', element: suspense(<SalesPage />) },
          { path: 'sorting', element: suspense(<SortingPage />) },
          { path: 'transfers', element: suspense(<TransfersPage />) },
          { path: 'catalog', element: suspense(<CatalogPage />) },
          { path: 'costs', element: suspense(<ReceivePage />) },
          { path: 'inbound-statistics', element: suspense(<InboundStatisticsPage />) },
          { path: 'reports', element: suspense(<ReportsPage />) },
          { path: 'stores', element: suspense(<StoresPage />) },
          { path: 'users', element: suspense(<UsersPage />) },
          { path: 'audit', element: suspense(<AuditPage />) },
          { path: 'settings', element: suspense(<SettingsPage />) },
        ],
      },
    ],
  },
  { path: '*', element: suspense(<NotFoundPage />), errorElement: pageError },
]);
