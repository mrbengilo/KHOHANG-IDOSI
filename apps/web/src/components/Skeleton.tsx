export function DashboardSkeleton() {
  return (
    <div aria-label="Đang tải dữ liệu" className="skeleton-grid" role="status">
      {Array.from({ length: 8 }, (_, index) => (
        <span className="skeleton" key={`skeleton-${index + 1}`} />
      ))}
    </div>
  );
}
