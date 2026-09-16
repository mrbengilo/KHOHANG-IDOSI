import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

import { Button } from './Button';
import { classes } from './utils';

export type ShellRole = 'admin' | 'htkd' | 'store';

export interface ShellNavItem {
  readonly to: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly end?: boolean;
}

export interface ShellProps {
  readonly role: ShellRole;
  readonly roleLabel: string;
  readonly title: string;
  readonly userLabel: string;
  readonly navigation: ReadonlyArray<ShellNavItem>;
  readonly mobileNavigation?: ReadonlyArray<ShellNavItem>;
  readonly footerLabel?: string;
  readonly children: ReactNode;
  readonly onLogout?: () => void;
}

function Navigation({
  items,
  mobile = false,
}: {
  readonly items: ReadonlyArray<ShellNavItem>;
  readonly mobile?: boolean;
}) {
  return (
    <nav
      className={mobile ? 'idosi-mobile-nav' : 'idosi-sidebar__nav'}
      aria-label={mobile ? 'Điều hướng nhanh' : 'Điều hướng chính'}
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          {...(item.end === undefined ? {} : { end: item.end })}
          className={({ isActive }) => classes('idosi-nav-link', isActive && 'is-active')}
        >
          <span className="idosi-nav-link__dot" aria-hidden="true" />
          <span>{mobile ? (item.shortLabel ?? item.label) : item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function Sidebar({
  footerLabel,
  navigation,
  roleLabel,
}: Pick<ShellProps, 'footerLabel' | 'navigation' | 'roleLabel'>) {
  return (
    <aside className="idosi-sidebar">
      <div className="idosi-sidebar__brand">IDOSI</div>
      <div className="idosi-sidebar__role">{roleLabel}</div>
      <Navigation items={navigation} />
      {footerLabel ? <p className="idosi-sidebar__footer">{footerLabel}</p> : null}
    </aside>
  );
}

export function MobileNav({ navigation }: { readonly navigation: ReadonlyArray<ShellNavItem> }) {
  return <Navigation items={navigation} mobile />;
}

export function Shell({
  children,
  footerLabel,
  mobileNavigation,
  navigation,
  onLogout,
  role,
  roleLabel,
  title,
  userLabel,
}: ShellProps) {
  const bottomItems = mobileNavigation ?? navigation;
  return (
    <div className="idosi-shell" data-role={role}>
      <a className="idosi-skip-link" href="#main-content">
        Bỏ qua điều hướng
      </a>
      <Sidebar
        roleLabel={roleLabel}
        navigation={navigation}
        {...(footerLabel === undefined ? {} : { footerLabel })}
      />
      <header className="idosi-topbar">
        <span className="idosi-topbar__mobile-brand">IDOSI</span>
        <h1>{title}</h1>
        <div className="idosi-topbar__account">
          <span>{userLabel}</span>
          {onLogout ? (
            <Button variant="ghost" size="sm" onClick={onLogout} aria-label="Đăng xuất">
              Đăng xuất
            </Button>
          ) : null}
        </div>
      </header>
      <main id="main-content" className="idosi-main" tabIndex={-1}>
        {children}
      </main>
      <MobileNav navigation={bottomItems} />
    </div>
  );
}
