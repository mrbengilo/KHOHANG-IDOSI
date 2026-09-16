export interface StoreGroupSeed {
  readonly code: string;
  readonly name: string;
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
  readonly displayOrder: number;
}

export const STORE_GROUP_SEEDS = [
  { code: 'SI_TINH', name: 'SỈ TỈNH', displayOrder: 1 },
  { code: 'DOSII_TINH', name: 'DOSII TỈNH', displayOrder: 2 },
  { code: 'DOSII_HCM', name: 'DOSII HCM', displayOrder: 3 },
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

export const PRODUCT_SEEDS = [
  { sku: 'DAM', slug: 'dam', name: 'Đầm', displayOrder: 1 },
  { sku: 'QUAN_JEANS', slug: 'quan-jeans', name: 'Quần jeans', displayOrder: 2 },
  { sku: 'QUAN_DAI_NU', slug: 'quan-dai-nu', name: 'Quần dài nữ', displayOrder: 3 },
  { sku: 'CHAN_VAY', slug: 'chan-vay', name: 'Chân váy', displayOrder: 4 },
  { sku: 'QUAN_SHORT', slug: 'quan-short', name: 'Quần short', displayOrder: 5 },
  { sku: 'TRE_EM', slug: 'tre-em', name: 'Trẻ em', displayOrder: 6 },
  { sku: 'DO_DONG', slug: 'do-dong', name: 'Đồ đông', displayOrder: 7 },
  { sku: 'DO_BO', slug: 'do-bo', name: 'Đồ bộ', displayOrder: 8 },
  { sku: 'DO_THE_THAO', slug: 'do-the-thao', name: 'Đồ thể thao', displayOrder: 9 },
  { sku: 'AO_KHOAC', slug: 'ao-khoac', name: 'Áo khoác', displayOrder: 10 },
  { sku: 'AO_NU', slug: 'ao-nu', name: 'Áo nữ', displayOrder: 11 },
  {
    sku: 'DO_NAM_CUA_HANG',
    slug: 'do-nam-cua-hang',
    name: 'Đồ nam cửa hàng',
    displayOrder: 12,
  },
  { sku: 'NAM_SM', slug: 'nam-sm', name: 'Nam SM', displayOrder: 13 },
  { sku: 'NU_SM', slug: 'nu-sm', name: 'Nữ SM', displayOrder: 14 },
  { sku: 'AO_VEST', slug: 'ao-vest', name: 'Áo vest', displayOrder: 15 },
  { sku: 'AO_DAI', slug: 'ao-dai', name: 'Áo dài', displayOrder: 16 },
  {
    sku: 'GIAY_DEP_TUI_XACH',
    slug: 'giay-dep-tui-xach',
    name: 'Giày dép túi xách',
    displayOrder: 17,
  },
  {
    sku: 'SAN_PHAM_TIEN_ICH',
    slug: 'san-pham-tien-ich',
    name: 'Sản phẩm tiện ích',
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
    name: 'Chăn ga, bao gối, nệm gòn',
    displayOrder: 23,
  },
  { sku: 'DO_NOI_Y_MOI', slug: 'do-noi-y-moi', name: 'Đồ nội y mới', displayOrder: 24 },
  { sku: 'GAU_BONG', slug: 'gau-bong', name: 'Gấu bông', displayOrder: 25 },
  { sku: 'THAP_CAM_TON', slug: 'thap-cam-ton', name: 'Thập cẩm tồn', displayOrder: 26 },
  {
    sku: 'HANG_JEANS_TAI_CHE',
    slug: 'hang-jeans-tai-che',
    name: 'Hàng jeans tái chế',
    displayOrder: 27,
  },
  {
    sku: 'HANG_THUN_TAI_CHE',
    slug: 'hang-thun-tai-che',
    name: 'Hàng thun tái chế',
    displayOrder: 28,
  },
] as const satisfies readonly ProductSeed[];
