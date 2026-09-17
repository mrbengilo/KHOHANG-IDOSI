import type { ReactNode } from 'react';

import { classes } from './utils';

export interface TableColumn<Row> {
  readonly id: string;
  readonly header: ReactNode;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'start' | 'center' | 'end';
  readonly width?: string;
}

export interface TableProps<Row> {
  readonly caption: string;
  readonly columns: ReadonlyArray<TableColumn<Row>>;
  readonly rows: ReadonlyArray<Row>;
  readonly getRowKey: (row: Row) => string;
  readonly renderMobile?: (row: Row) => ReactNode;
  readonly empty?: ReactNode;
  readonly className?: string;
}

export function Table<Row>({
  caption,
  className,
  columns,
  empty,
  getRowKey,
  renderMobile,
  rows,
}: TableProps<Row>) {
  if (rows.length === 0) return <>{empty ?? null}</>;

  return (
    <div className={classes('idosi-table-wrap', className)}>
      <table className="idosi-table">
        <caption className="idosi-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={`is-${column.align ?? 'start'}`}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td key={column.id} className={`is-${column.align ?? 'start'}`}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {renderMobile ? (
        <div className="idosi-table-cards">
          {rows.map((row) => (
            <article className="idosi-table-card" key={getRowKey(row)}>
              {renderMobile(row)}
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
