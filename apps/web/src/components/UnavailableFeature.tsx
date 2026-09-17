import { Unplug } from 'lucide-react';

interface UnavailableFeatureProps {
  readonly title: string;
}

export function UnavailableFeature({ title }: UnavailableFeatureProps) {
  return (
    <section className="feature-unavailable" role="status">
      <Unplug aria-hidden="true" size={30} />
      <h1>{title}</h1>
      <p>
        Màn hình này chưa được nối với API nghiệp vụ. Dữ liệu minh họa và các thao tác giả lập đã bị
        tắt trong môi trường vận hành.
      </p>
    </section>
  );
}
