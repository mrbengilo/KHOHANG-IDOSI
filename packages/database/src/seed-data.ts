export interface StoreGroupSeed {
  readonly code: string;
  readonly name: string;
  readonly kind: 'retail' | 'wholesale';
  readonly displayOrder: number;
}

export interface StoreSeed {
  readonly code: string;
  readonly name: string;
  readonly groupCode: string;
  readonly displayOrder: number;
}

export interface ProductSeed {
  readonly sku: string;
  readonly slug: string;
  readonly name: string;
  readonly unit: 'bag';
  readonly displayOrder: number;
}

export interface ProductConversionSeed {
  readonly productSku: string;
  readonly version: 1;
  readonly itemQuantity: number;
  readonly weightKilograms: string;
  readonly effectiveFrom: '2026-09-12';
  readonly effectiveTo: null;
  readonly reason: string;
}

export const STORE_GROUP_SEEDS = [
  { code: 'SI_TINH', name: 'KHÁCH SỈ', kind: 'wholesale', displayOrder: 1 },
  { code: 'DOSII_TINH', name: 'DOSII TỈNH', kind: 'retail', displayOrder: 2 },
  { code: 'DOSII_HCM', name: 'DOSII HCM', kind: 'retail', displayOrder: 3 },
] as const satisfies readonly StoreGroupSeed[];

export const STORE_SEEDS = [
  { code: 'LX', name: 'LX', groupCode: 'SI_TINH', displayOrder: 1 },
  { code: 'VL', name: 'VL', groupCode: 'SI_TINH', displayOrder: 2 },
  { code: 'CT', name: 'CT', groupCode: 'SI_TINH', displayOrder: 3 },
  { code: 'TK', name: 'TK', groupCode: 'SI_TINH', displayOrder: 4 },
  { code: 'DS_BMT', name: 'DS BMT', groupCode: 'DOSII_TINH', displayOrder: 5 },
  { code: 'DS_CT', name: 'DS CT', groupCode: 'DOSII_TINH', displayOrder: 6 },
  { code: 'DS_NVT', name: 'DS NVT', groupCode: 'DOSII_HCM', displayOrder: 7 },
  { code: 'DS_BD', name: 'DS BD', groupCode: 'DOSII_HCM', displayOrder: 8 },
  { code: 'DS_NTL', name: 'DS NTL', groupCode: 'DOSII_HCM', displayOrder: 9 },
  { code: 'DS_TNV', name: 'DS TNV', groupCode: 'DOSII_HCM', displayOrder: 10 },
  { code: 'DS_LVT', name: 'DS LVT', groupCode: 'DOSII_HCM', displayOrder: 11 },
  { code: 'SM_TNV', name: 'SM TNV', groupCode: 'DOSII_HCM', displayOrder: 12 },
  { code: 'DS_TH', name: 'DS TH', groupCode: 'DOSII_HCM', displayOrder: 13 },
  { code: 'DS_KVC', name: 'DS KVC', groupCode: 'DOSII_HCM', displayOrder: 14 },
] as const satisfies readonly StoreSeed[];

const PRODUCT_SEED_DEFINITIONS = [
  { sku: 'DAM', slug: 'dam', name: 'Đầm', displayOrder: 1 },
  { sku: 'QUAN_JEANS', slug: 'quan-jeans', name: 'Quần Jeans', displayOrder: 2 },
  { sku: 'QUAN_DAI_NU', slug: 'quan-dai-nu', name: 'Quần dài nữ', displayOrder: 3 },
  { sku: 'CHAN_VAY', slug: 'chan-vay', name: 'Chân váy', displayOrder: 4 },
  { sku: 'QUAN_SHORT', slug: 'quan-short', name: 'Quần short', displayOrder: 5 },
  { sku: 'TRE_EM', slug: 'tre-em', name: 'Trẻ em', displayOrder: 6 },
  { sku: 'DO_DONG', slug: 'do-dong', name: 'Đồ đông', displayOrder: 7 },
  { sku: 'DO_BO', slug: 'do-bo', name: 'Đồ bộ', displayOrder: 8 },
  { sku: 'DO_THE_THAO', slug: 'do-the-thao', name: 'Đồ thể thao', displayOrder: 9 },
  { sku: 'AO_KHOAC', slug: 'ao-khoac', name: 'Áo khoác', displayOrder: 10 },
  { sku: 'AO_NU', slug: 'ao-nu', name: 'Áo nữ', displayOrder: 11 },
  { sku: 'DO_NAM', slug: 'do-nam', name: 'Quần áo nam', displayOrder: 12 },
  { sku: 'NAM_SM', slug: 'nam-sm', name: 'Nam SM', displayOrder: 13 },
  { sku: 'NU_SM', slug: 'nu-sm', name: 'Nữ SM', displayOrder: 14 },
  { sku: 'AO_VEST', slug: 'ao-vest', name: 'Áo vest', displayOrder: 15 },
  { sku: 'AO_DAI', slug: 'ao-dai', name: 'Áo dài', displayOrder: 16 },
  {
    sku: 'SAN_PHAM_TIEN_ICH',
    slug: 'san-pham-tien-ich',
    name: 'Sản phẩm tiện ích',
    displayOrder: 17,
  },
  {
    sku: 'GIAY_DEP_TUI_XACH',
    slug: 'giay-dep-tui-xach',
    name: 'Giày dép túi xách',
    displayOrder: 18,
  },
  { sku: 'BIG_SIZE', slug: 'big-size', name: 'Big size', displayOrder: 19 },
  {
    sku: 'HANG_THUONG_HIEU',
    slug: 'hang-thuong-hieu',
    name: 'Hàng thương hiệu',
    displayOrder: 20,
  },
  { sku: 'TRE_EM_SM', slug: 'tre-em-sm', name: 'Trẻ em SM', displayOrder: 21 },
  { sku: 'KHAN_LONG', slug: 'khan-long', name: 'Khăn lông', displayOrder: 22 },
  {
    sku: 'CHAN_GA_BAO_GOI_NEM_GON',
    slug: 'chan-ga-bao-goi-nem-gon',
    name: 'Chăn, ga, bao gối, nệm gòn',
    displayOrder: 23,
  },
  { sku: 'DO_NOI_Y_MOI', slug: 'do-noi-y-moi', name: 'Đồ nội y mới', displayOrder: 24 },
  { sku: 'GAU_BONG', slug: 'gau-bong', name: 'Gấu bông', displayOrder: 25 },
] as const satisfies readonly Omit<ProductSeed, 'unit'>[];

export const PRODUCT_SEEDS = PRODUCT_SEED_DEFINITIONS.map((product) => ({
  ...product,
  unit: 'bag' as const,
})) satisfies readonly ProductSeed[];

const PRODUCT_CONVERSION_REASON = 'Initial Figma catalog conversion effective 2026-09-12';

/** Exact rational conversions; never derive these values from JavaScript division. */
export const PRODUCT_CONVERSION_SEEDS = [
  { productSku: 'DAM', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'QUAN_JEANS', itemQuantity: 2, weightKilograms: '1.000' },
  { productSku: 'QUAN_DAI_NU', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'CHAN_VAY', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'QUAN_SHORT', itemQuantity: 4, weightKilograms: '1.000' },
  { productSku: 'TRE_EM', itemQuantity: 6, weightKilograms: '1.000' },
  { productSku: 'DO_DONG', itemQuantity: 1, weightKilograms: '1.000' },
  { productSku: 'DO_BO', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'DO_THE_THAO', itemQuantity: 4, weightKilograms: '1.000' },
  { productSku: 'AO_KHOAC', itemQuantity: 2, weightKilograms: '1.000' },
  { productSku: 'AO_NU', itemQuantity: 5, weightKilograms: '1.000' },
  { productSku: 'DO_NAM', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'NAM_SM', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'NU_SM', itemQuantity: 5, weightKilograms: '1.000' },
  { productSku: 'AO_VEST', itemQuantity: 1, weightKilograms: '1.000' },
  { productSku: 'AO_DAI', itemQuantity: 2, weightKilograms: '1.000' },
  { productSku: 'SAN_PHAM_TIEN_ICH', itemQuantity: 1, weightKilograms: '1.000' },
  { productSku: 'GIAY_DEP_TUI_XACH', itemQuantity: 1, weightKilograms: '1.000' },
  { productSku: 'BIG_SIZE', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'HANG_THUONG_HIEU', itemQuantity: 3, weightKilograms: '1.000' },
  { productSku: 'TRE_EM_SM', itemQuantity: 6, weightKilograms: '1.000' },
  { productSku: 'KHAN_LONG', itemQuantity: 2, weightKilograms: '1.000' },
  { productSku: 'CHAN_GA_BAO_GOI_NEM_GON', itemQuantity: 1, weightKilograms: '3.000' },
  { productSku: 'DO_NOI_Y_MOI', itemQuantity: 4, weightKilograms: '1.000' },
  { productSku: 'GAU_BONG', itemQuantity: 2, weightKilograms: '1.000' },
].map((conversion) => ({
  ...conversion,
  version: 1 as const,
  effectiveFrom: '2026-09-12' as const,
  effectiveTo: null,
  reason: PRODUCT_CONVERSION_REASON,
})) satisfies readonly ProductConversionSeed[];
