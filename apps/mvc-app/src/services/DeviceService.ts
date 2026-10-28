import { db } from '@/db/connection';
import { badRequest, conflict, isDuplicateKey, notFound } from '@/lib/errors';
import { keyFingerprint, ManifestError, parseDevicePublicKey } from '@/lib/captureManifest';
import { newId } from '@/lib/ids';
import { AuditModel } from '@/models/AuditModel';
import { DeviceModel } from '@/models/DeviceModel';
import type { AuthUser } from '@/middleware/auth';

export const MAX_ACTIVE_DEVICES = 5;

/**
 * Registers the app install's signing key. Called by the apps after every sign-in (idempotent). Play Integrity
 * attestation is not part of this edition: the attestation fields are accepted and ignored, and every key is
 * recorded as UNVERIFIED.
 */
export const DeviceService = {
  async register(user: AuthUser, v: { publicKey: string; platform: string; appVersion?: string }, ip: string | null) {
    try {
      parseDevicePublicKey(v.publicKey);
    } catch (err) {
      if (err instanceof ManifestError) throw badRequest(err.message);
      throw err;
    }
    const fingerprint = keyFingerprint(v.publicKey);
    try {
      return await db().transaction(async (trx) => {
        const existing = await DeviceModel.findByFingerprint(trx, fingerprint, true);
        let id: string;
        if (existing) {
          if (existing.user_id !== user.id) throw conflict('This device key is registered to another account');
          await DeviceModel.touch(trx, existing.id, v.appVersion);
          id = existing.id;
        } else {
          id = newId();
          await DeviceModel.insert(trx, { id, userId: user.id, publicKey: v.publicKey, fingerprint, platform: v.platform, appVersion: v.appVersion });
          await AuditModel.log(trx, { actorId: user.id, action: 'DEVICE_REGISTERED', entity: 'device', entityId: id, ip, meta: { platform: v.platform, integrity: 'UNVERIFIED' } });
        }
        await DeviceModel.trimActive(trx, user.id, MAX_ACTIVE_DEVICES);
        return { id };
      });
    } catch (err) {
      // Two installs registering the very same key at once: the unique index decides.
      if (isDuplicateKey(err)) throw conflict('This device key is registered to another account');
      throw err;
    }
  },

  list: (user: AuthUser) => DeviceModel.list(db(), user.id),

  async revoke(user: AuthUser, id: string, ip: string | null) {
    if (!(await DeviceModel.revoke(db(), user.id, id))) throw notFound('Device not found');
    await AuditModel.log(db(), { actorId: user.id, action: 'DEVICE_REVOKED', entity: 'device', entityId: id, ip });
  },
};
