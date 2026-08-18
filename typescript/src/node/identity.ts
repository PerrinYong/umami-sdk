import { createHash, createHmac, randomUUID } from 'node:crypto';

export function createInstallationId(): string {
  return randomUUID();
}

export function deriveInstallationSubjectId(productScope: string, installationId: string): string {
  if (!productScope || !installationId) throw new Error('productScope and installationId are required');
  return createHash('sha256')
    .update(`${productScope}\0${installationId}`, 'utf8')
    .digest('base64url');
}

export function deriveUserSubjectId(productKey: Uint8Array, internalUserId: string): string {
  if (productKey.length < 32 || !internalUserId) {
    throw new Error('a 32-byte productKey and internalUserId are required');
  }
  return createHmac('sha256', productKey).update(internalUserId, 'utf8').digest('base64url');
}
