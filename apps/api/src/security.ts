import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEY_BYTES = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/** Versioned, self-describing scrypt encoding. The password itself is never persisted. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await scrypt(password, salt);
  return [
    'scrypt',
    'v1',
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELISM),
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, version, cost, blockSize, parallelism, saltText, digestText] =
    encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    version !== 'v1' ||
    cost !== String(SCRYPT_COST) ||
    blockSize !== String(SCRYPT_BLOCK_SIZE) ||
    parallelism !== String(SCRYPT_PARALLELISM) ||
    !saltText ||
    !digestText
  ) {
    return false;
  }

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(digestText, 'base64url');
    salt = Buffer.from(saltText, 'base64url');
  } catch {
    return false;
  }
  if (expected.byteLength !== SCRYPT_KEY_BYTES || salt.byteLength !== 16) return false;
  const actual = await scrypt(password, salt);
  return timingSafeEqual(actual, expected);
}

export function newOpaqueSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashCanonicalRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
