import { closeDatabase, db } from './client.js';
import { seedReferenceData } from './reference-seed.js';
import {
  PRODUCT_CONVERSION_SEEDS,
  PRODUCT_SEEDS,
  STORE_GROUP_SEEDS,
  STORE_SEEDS,
} from './seed-data.js';

export { seedReferenceData } from './reference-seed.js';

try {
  await seedReferenceData(db);
  console.info(
    `Ensured ${STORE_GROUP_SEEDS.length} store groups, ${STORE_SEEDS.length} stores, ${PRODUCT_SEEDS.length} products, and ${PRODUCT_CONVERSION_SEEDS.length} product conversions exist without changing managed rows.`,
  );
} catch (error: unknown) {
  console.error('Database seed failed.', error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
