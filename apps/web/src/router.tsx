import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { DashboardSkeleton } from './components/Skeleton';

const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
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
const CostPage = lazy(() =>
  import('./pages/OperationsPages').then((module) => ({ default: module.CostPage })),
);
const UsersPage = lazy(() =>
  import('./features/admin/AdminUsersPage').then((module) => ({
    default: module.AdminUsersPage,
  })),
);
const AuditPage = lazy(() =>
  import('./features/admin/AuditLogPage').then((module) => ({ default: module.AuditLogPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/AdminPages').then((module) => ({ default: module.SettingsPage })),
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

export const router = createBrowserRouter([
  { path: '/login', element: suspense(<LoginPage />) },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: suspense(<DashboardPage />) },
      { path: 'allocations', element: suspense(<AllocationPage />) },
      { path: 'requests', element: suspense(<RequestsPage />) },
      { path: 'receive', element: suspense(<ReceivePage />) },
      { path: 'inventory', element: suspense(<InventoryPage />) },
      { path: 'open-bag', element: suspense(<OpenBagPage />) },
      { path: 'sales', element: suspense(<SalesPage />) },
      { path: 'sorting', element: suspense(<SortingPage />) },
      { path: 'transfers', element: suspense(<TransfersPage />) },
      { path: 'catalog', element: suspense(<CatalogPage />) },
      { path: 'costs', element: suspense(<CostPage />) },
      { path: 'reports', element: suspense(<ReportsPage />) },
      { path: 'users', element: suspense(<UsersPage />) },
      { path: 'audit', element: suspense(<AuditPage />) },
      { path: 'settings', element: suspense(<SettingsPage />) },
    ],
  },
  { path: '*', element: suspense(<NotFoundPage />) },
]);
