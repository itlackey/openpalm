import {
  decodePairingCode,
  type DecodePairingResult,
  type PairingPayloadV1,
} from '@openpalm/lib/pairing.js';

export type PairingPayload = PairingPayloadV1;
export type ParsePairingResult = DecodePairingResult;
export const parsePairingCode = decodePairingCode;
