// Stable error codes for Kvalah Compute v0.2. Never use assert/exception text as a protocol contract:
// every refusal carries one of these codes, an HTTP status and a correlation id (see docs/compute/protocol.md).
export const CODES={
  UNAUTHORIZED:401, BAD_SIGNATURE:401, CLOCK_SKEW:401, REPLAY:401,
  REVOKED:403, FORBIDDEN_SCOPE:403, NOT_OWNER:403, PENDING_APPROVAL:403, CONSENT_REQUIRED:403,
  NOT_FOUND:404,
  STALE:409, CONFLICT:409, DUPLICATE_DIFFERENT:409, SESSION_SUPERSEDED:409, INVALID_TRANSITION:409, IMMUTABLE:409, STOPPED:409, PAUSED:409,
  LEASE_EXPIRED:410, PAIRING_EXPIRED:410,
  TOO_LARGE:413,
  INVALID_SCHEMA:422, INVALID_TENSOR:422, NONFINITE:422, HASH_MISMATCH:422, TOKEN_MISMATCH:422, FROZEN_A_CHANGED:422,
  RUNTIME_REQUIRED:422, MODEL_REQUIRED:422, PREFLIGHT_FAILED:422, DOWNLOAD_APPROVAL:422, SETUP_REQUIRED:422, INVITE_REPLACE:409, DISK_SPACE:422, SMOKE_BLOCKED:409,
  UNSUPPORTED_PROTOCOL:422, DATASET_REQUIRED:422, DATASET_INVALID:422, MODEL_UNVERIFIED:422, NO_TARGET_TOKENS:422,
  RATE_LIMITED:429, TOO_MANY_ATTEMPTS:429, TRAFFIC_CAP:429,
  UNAVAILABLE:503, NO_TASK:204,
  INTERNAL:500
};
export class ComputeError extends Error{
  constructor(code,message,details){
    super(message||code);
    this.code=CODES[code]?code:'INTERNAL';
    this.status=CODES[this.code];
    if(details!==undefined)this.details=details;
  }
}
export const fail=(code,message,details)=>{throw new ComputeError(code,message,details);};
export function errorBody(e,correlationId){
  const c=e instanceof ComputeError?e:new ComputeError('INTERNAL','internal error');
  return {error:{code:c.code,message:c.message,correlation_id:correlationId,...(c.details&&typeof c.details==='object'?{details:c.details}:{})}};
}
