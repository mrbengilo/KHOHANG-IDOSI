import { useLayoutEffect, useRef, type ComponentProps } from 'react';

/**
 * Measure only the header when its labels, font or containing width change. Body cells must
 * not force a fitting header to wrap. Observe the scrollport, never the table we resize.
 * Row numbering remains explicit at the call site because pagination may count documents.
 */
export function DataTable({ className = '', children, ...props }: ComponentProps<'table'>) {
  const ref = useRef<HTMLTableElement>(null);
  const measurement = useRef({ signature: '', width: 0, widths: [] as number[] });
  useLayoutEffect(() => {
    const table = ref.current;
    const container = table?.parentElement;
    if (!table || !container || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    let disposed = false;
    const measure = () => {
      if (disposed || !table.tHead || !container.clientWidth) return;
      const headers = Array.from(table.tHead.querySelectorAll('th'));
      if (!headers.length || getComputedStyle(table).display !== 'table') return;
      const containerStyle = getComputedStyle(container);
      const width =
        container.clientWidth -
        parseFloat(containerStyle.paddingLeft) -
        parseFloat(containerStyle.paddingRight);
      const signature = headers
        .map((cell) => `${cell.textContent}|${getComputedStyle(cell).font}`)
        .join('\n');
      let widths = measurement.current.widths;
      if (signature !== measurement.current.signature) {
        const probe = document.createElement('table');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText =
          'position:fixed;left:-100000px;top:0;visibility:hidden;width:max-content;min-width:0;max-width:none;table-layout:auto;';
        const row = probe.insertRow();
        for (const header of headers) {
          const cell = header.cloneNode(true) as HTMLTableCellElement;
          const style = getComputedStyle(header);
          cell.removeAttribute('id');
          cell.style.cssText = `display:table-cell;width:auto;min-width:0;max-width:none;white-space:nowrap;overflow-wrap:normal;word-break:normal;font:${style.font};padding:${style.padding};border:${style.border};`;
          row.append(cell);
        }
        document.body.append(probe);
        widths = Array.from(row.cells, (cell) => Math.ceil(cell.getBoundingClientRect().width));
        probe.remove();
      } else if (Math.abs(width - measurement.current.width) < 0.5) return;
      const required = widths.reduce((sum, value) => sum + value, 0);
      table.dataset.headerWrap = required > width + 1 ? 'true' : 'false';
      table.dataset.headerRequiredWidth = String(required);
      headers.forEach((header, index) =>
        header.style.setProperty('--header-min-width', `${widths[index] ?? 0}px`),
      );
      measurement.current = { signature, width, widths };
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    // Set initial header geometry before paint/scroll restoration. Deferring this first
    // measurement changes the document height after the router has restored its offset.
    measure();
    void document.fonts?.ready.then(schedule);
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [children]);
  return (
    <table {...props} className={`data-table ${className}`} ref={ref}>
      {children}
    </table>
  );
}
