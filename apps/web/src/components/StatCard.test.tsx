import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatCard } from './StatCard';

describe('StatCard emphasis', () => {
  it('keeps the business tone and adds the important modifier independently', () => {
    const html = renderToStaticMarkup(
      <StatCard detail="d" emphasis="important" label="Thiếu" tone="success" value="3" />,
    );
    expect(html).toContain('stat-card--success');
    expect(html).toContain('stat-card--important');
  });

  it('is backwards compatible without emphasis', () => {
    const html = renderToStaticMarkup(<StatCard detail="d" label="Tồn" value="3" />);
    expect(html).toContain('stat-card--neutral');
    expect(html).not.toContain('stat-card--important');
  });
});
