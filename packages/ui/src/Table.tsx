import type { ReactNode } from 'react';

import { classes } from './utils';
import { DataTable } from './DataTable';

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
  /** Number of data rows before this server/client page. */
  readonly rowOffset?: number;
}

export function Table<Row>({
  caption,
  className,
  columns,
  empty,
  getRowKey,
  renderMobile,
  rows,
  rowOffset = 0,
}: TableProps<Row>) {
  if (rows.length === 0) return <>{empty ?? null}</>;

  const addRowNumbers = !columns.some((column) => column.header === 'STT');
  return (
    <div className={classes('idosi-table-wrap', className)}>
      <DataTable className="idosi-table">
        <caption className="idosi-sr-only">{caption}</caption>
        <thead>
          <tr>
            {addRowNumbers ? (
              <th scope="col" className="table-index">
                STT
              </th>
            ) : null}
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
          {rows.map((row, index) => (
            <tr key={getRowKey(row)}>
              {addRowNumbers ? (
                <td className="table-index" data-label="STT">
                  {rowOffset + index + 1}
                </td>
              ) : null}
              {columns.map((column) => (
                <td key={column.id} className={`is-${column.align ?? 'start'}`}>
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </DataTable>
      {renderMobile ? (
        <div className="idosi-table-cards">
          {rows.map((row, index) => (
            <article className="idosi-table-card" key={getRowKey(row)}>
              {addRowNumbers ? <p className="table-index">STT: {rowOffset + index + 1}</p> : null}
              {renderMobile(row)}
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
