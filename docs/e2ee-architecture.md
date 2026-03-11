# Messly E2EE Architecture (V2)

## Summary
- The current E2EE stack is session-based per device, not a single shared AES key per conversation.
- Message payloads use `AES-GCM` only as the content primitive; key agreement and session state are handled separately.
- Envelopes are versioned (`version: 2`) and explicit about sender/recipient device and session metadata.
- The code is structured for future migration to official `libsignal` while remaining compatible with browser/Electron Web Crypto today.

## Modules
- `src/services/crypto/e2ee/identity.ts`
  - Device identity generation (`ECDH P-256` + `ECDSA P-256`).
  - Public identity export and signatures.
- `src/services/crypto/e2ee/prekeys.ts`
  - Signed prekey and one-time prekey generation/verification.
  - Public prekey bundle creation per device.
- `src/services/crypto/e2ee/session.ts`
  - X3DH-compatible session establishment (initiator/responder).
  - Session state with ratchet keys and chain counters.
- `src/services/crypto/e2ee/message.ts`
  - Per-message encryption/decryption with evolving chain keys.
  - Replay detection and skipped-message handling.
- `src/services/crypto/e2ee/storage.ts`
  - Protected wrapping/unwrap for local key persistence.
  - Session and identity serialization/deserialization.
- `src/services/crypto/e2ee/serialization.ts`
  - Envelope schema validation and canonical serialization/signature payloads.
  - Legacy envelope compatibility parsing.
- `src/services/crypto/e2ee/protocol.ts`
  - Device trust/revocation, multi-device fanout, pending queue/retry, membership rekey orchestration.

## Session Flow
1. Each device creates its own identity key pairs.
2. Recipient publishes a prekey bundle (identity public keys + signed prekey + optional one-time prekey).
3. Initiator verifies signed prekey signature and derives shared secret material.
4. Recipient accepts `session_init`, verifies sender signature, derives the same secret, and consumes one-time prekey when used.
5. Both sides derive root/sending/receiving chain keys.
6. Messages are encrypted with per-message derived keys and envelope signatures.
7. Ratchet keys evolve over time; replayed or stale envelopes are rejected.

## What The Server Knows
- Public identity keys and prekey bundle metadata.
- Envelope metadata needed for routing:
  - conversation/session identifiers
  - sender/recipient device IDs
  - counters and algorithm/version fields
- Ciphertext envelope bytes.

## What The Server Does Not Know
- Session root keys or chain keys.
- Message plaintext.
- Private device identity keys or private prekeys.
- Local replay/skipped state and trust decisions.

## Multi-Device Model
- Sessions are created per recipient device.
- Fanout encryption creates one envelope per authorized recipient device.
- New devices start with a prekey bundle and independent session state.
- Revoked devices can be blocked from conversation-level routing and new encryption.

## Rekey Behavior
- Membership/device changes generate `MembershipRekeyPlan`.
- `member_removed`/`device_revoked` removes sessions and blocks future encryption for removed device(s).
- `member_added`/`device_added` rotates session references (new session IDs) and re-establishes secure state.

## Security/Operational Notes
- Do not log plaintext, raw key bytes, or full encrypted payload dumps.
- Keep identity/private keys non-exportable by default unless persistence wrapping is explicitly required.
- Treat decrypt failure, missing session, replay, and unverified device as explicit UX states.

## libsignal Migration Path
- `src/services/crypto/e2ee/libsignalAdapter.ts` checks runtime availability of `@signalapp/libsignal-client`.
- `SignalProtocolAdapter` provides a stable integration seam:
  - current provider: `webcrypto-ratchet`
  - target provider: `libsignal`
- Existing call sites can swap providers without rewriting business-layer routing logic.
