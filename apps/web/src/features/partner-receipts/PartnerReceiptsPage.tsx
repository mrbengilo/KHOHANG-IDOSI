import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePartnerReceiptRequest, PartnerReceipt } from '@idosi/contracts';
import { PackagePlus, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { DashboardSkeleton } from '../../components/Skeleton';
import { listCatalog } from '../../lib/api';
import type { ProductConversion as CatalogProduct } from '../../lib/types';
import { useSession } from '../../lib/auth';
import { createPartnerReceipt, listPartnerReceipts } from './partnerReceiptsApi';

const statusCopy: Record<
  PartnerReceipt['status'],
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' }
> = {
  DRAFT: { label: 'Nháp', tone: 'neutral' },
  CONFIRMED: { label: 'Đã xác nhận', tone: 'success' },
  CANCELLED: { label: 'Đã hủy', tone: 'warning' },
};

interface ReceiptLine {
  productId: string;
  quantity: number;
}

export function PartnerReceiptsPage() {
  const sessionQuery = useSession();
  const principal = sessionQuery.data?.principal;
  const queryClient = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [partnerName, setPartnerName] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<ReceiptLine[]>([{ productId: '', quantity: 1 }]);

  const receiptsQuery = useQuery({
    queryKey: ['partner-receipts', principal?.accountId, principal?.storeId],
    queryFn: () => {
      if (!principal?.storeId) throw new Error('Phiên đăng nhập không có cửa hàng');
      return listPartnerReceipts({ storeId: principal.storeId, page: 1, pageSize: 50 });
    },
    enabled: principal?.role === 'STORE' && !!principal.storeId,
  });

  const productsQuery = useQuery({
    queryKey: ['catalog'],
    queryFn: () => listCatalog(),
    enabled: principal?.role === 'STORE' && !!principal.storeId,
  });

  const createMutation = useMutation({
    mutationFn: (input: CreatePartnerReceiptRequest) => createPartnerReceipt(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['partner-receipts'] });
      setShowForm(false);
      setPartnerName('');
      setNotes('');
      setLines([{ productId: '', quantity: 1 }]);
    },
  });

  const handleAddLine = () => {
    setLines([...lines, { productId: '', quantity: 1 }]);
  };

  const handleRemoveLine = (index: number) => {
    setLines(lines.filter((_, i) => i !== index));
  };

  const handleLineChange = (index: number, field: keyof ReceiptLine, value: string | number) => {
    setLines((current) =>
      current.map((line, currentIndex) =>
        currentIndex === index ? { ...line, [field]: value } : line,
      ),
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!principal?.storeId) return;

    const validLines = lines.filter(
      (line): line is { productId: string; quantity: number } =>
        line.productId !== '' && line.quantity > 0,
    );
    if (validLines.length === 0) return;

    createMutation.mutate({
      storeId: principal.storeId,
      partnerName: partnerName.trim(),
      notes: notes.trim() || undefined,
      lines: validLines,
    });
  };

  if (sessionQuery.isLoading) return <DashboardSkeleton />;

  if (principal?.role !== 'STORE' || !principal.storeId) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center py-12">
          <PackagePlus className="w-16 h-16 mx-auto text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">Không có quyền truy cập</h3>
          <p className="text-gray-600">Chỉ tài khoản cửa hàng mới có thể xem phiếu nhập đối tác</p>
        </div>
      </div>
    );
  }

  if (receiptsQuery.isLoading || productsQuery.isLoading) {
    return <DashboardSkeleton />;
  }

  if (receiptsQuery.isError || productsQuery.isError) {
    const error = receiptsQuery.error ?? productsQuery.error;
    return (
      <div role="alert">{error instanceof Error ? error.message : 'Không tải được dữ liệu'}</div>
    );
  }

  const receipts = receiptsQuery.data?.data ?? [];
  const products = productsQuery.data ?? [];

  return (
    <div className="container mx-auto px-4 py-6">
      <PageHeader
        title="Nhập hàng đối tác khác"
        description="Quản lý phiếu nhập hàng từ các đối tác bên ngoài"
      />

      {!showForm && (
        <div className="mb-4">
          <Button onClick={() => setShowForm(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Tạo phiếu nhập
          </Button>
        </div>
      )}

      {showForm && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Tạo phiếu nhập mới</h3>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="partnerName" className="block text-sm font-medium text-gray-700 mb-1">
                Tên đối tác <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                id="partnerName"
                value={partnerName}
                onChange={(e) => setPartnerName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Nhập tên đối tác"
                required
                minLength={2}
                maxLength={200}
              />
            </div>

            <div>
              <label htmlFor="notes" className="block text-sm font-medium text-gray-700 mb-1">
                Ghi chú
              </label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Ghi chú (tùy chọn)"
                rows={3}
                maxLength={1000}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700">
                  Chi tiết hàng hóa <span className="text-red-500">*</span>
                </label>
                <Button type="button" onClick={handleAddLine}>
                  <Plus className="w-4 h-4 mr-1" />
                  Thêm dòng
                </Button>
              </div>

              <div className="space-y-2">
                {lines.map((line, index) => (
                  <div key={index} className="flex gap-2 items-start">
                    <div className="flex-1">
                      <select
                        value={line.productId}
                        onChange={(e) => handleLineChange(index, 'productId', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        required
                      >
                        <option value="">Chọn mặt hàng</option>
                        {products.map((product: CatalogProduct) => (
                          <option key={product.id} value={product.id}>
                            {product.name} ({product.sku})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="w-32">
                      <input
                        type="number"
                        value={line.quantity}
                        onChange={(e) =>
                          handleLineChange(index, 'quantity', parseInt(e.target.value, 10) || 0)
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Số lượng"
                        required
                        min={1}
                      />
                    </div>
                    {lines.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveLine(index)}
                        className="px-3 py-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-4 border-t">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Hủy
              </button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Đang lưu...' : 'Lưu phiếu nhập'}
              </Button>
            </div>

            {createMutation.isError && (
              <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md">
                {createMutation.error instanceof Error
                  ? createMutation.error.message
                  : 'Có lỗi xảy ra khi tạo phiếu nhập'}
              </div>
            )}
          </form>
        </div>
      )}

      {receipts.length === 0 ? (
        <div className="text-center py-12">
          <PackagePlus className="w-16 h-16 mx-auto text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">Chưa có phiếu nhập</h3>
          <p className="text-gray-600 mb-4">Bạn chưa tạo phiếu nhập hàng đối tác nào</p>
          {!showForm && (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Tạo phiếu nhập đầu tiên
            </Button>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Số phiếu
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Đối tác
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Số lượng
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Trạng thái
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Ngày tạo
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {receipts.map((receipt) => (
                  <tr key={receipt.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {receipt.receiptNumber}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900">{receipt.partnerName}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{receipt.totalQuantity}</td>
                    <td className="px-4 py-3 text-sm">
                      <Badge tone={statusCopy[receipt.status].tone}>
                        {statusCopy[receipt.status].label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {new Date(receipt.createdAt).toLocaleDateString('vi-VN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
