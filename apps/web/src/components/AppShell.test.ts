import { describe, expect, it } from 'vitest';
import { navigationSections } from './AppShell';

function labelsBySection(...args: Parameters<typeof navigationSections>) {
  return navigationSections(...args).map(({ group, entries }) => ({
    group,
    labels: entries.map((entry) => entry.label),
  }));
}

describe('sidebar navigation groups', () => {
  it('puts admin-only screens under Quản trị with the system log last', () => {
    const sections = labelsBySection('ADMIN', null);
    expect(sections.map((section) => section.group)).toEqual(['operations', 'administration']);
    expect(sections[1]?.labels).toEqual([
      'Cửa hàng & nhóm',
      'Tài khoản',
      'Danh mục & quy đổi',
      'Cấu hình',
      'Nhật ký hệ thống',
    ]);
    expect(sections[0]?.labels).toContain('Báo cáo');
    expect(sections.flatMap((section) => section.labels)).not.toContain('Audit');
  });

  it('shows HTKD only the catalog under Quản trị and never the system log', () => {
    const sections = labelsBySection('HTKD', null);
    expect(sections[1]).toEqual({ group: 'administration', labels: ['Danh mục & quy đổi'] });
    expect(sections.flatMap((section) => section.labels)).not.toContain('Nhật ký hệ thống');
  });

  it.each([
    ['STORE', 'RETAIL'],
    ['WHOLESALE', null],
  ] as const)('keeps a single operations group for %s', (role, storeKind) => {
    const sections = labelsBySection(role, storeKind);
    expect(sections.map((section) => section.group)).toEqual(['operations']);
  });
});
