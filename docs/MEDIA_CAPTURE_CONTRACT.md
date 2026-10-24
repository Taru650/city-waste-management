# Media capture contract (for the Flutter apps)

The API accepts only photos and videos captured **inside the app**. This is enforced by a
per-install signing key and a signed capture manifest, then re-checked on the server.
Gallery, file pickers and share-intents must not exist in either app.

## 1. Device key (once per install, re-register after every login)
- Generate an **EC P-256** key pair in Android Keystore (`KeyProperties.KEY_ALGORITHM_EC`, `secp256r1`, purpose SIGN, digest SHA-256; StrongBox when available). iOS: Secure Enclave P-256.
- `POST /api/v1/devices` `{ publicKey: base64(SPKI DER), platform: "ANDROID"|"IOS", appVersion }` → `{ id }`.
- Logout-all and password reset revoke device keys; registering the same key again re-activates it.

## 2. Capture rules in the app
- Custom camera screen (`camera` plugin). Photo: compress on device to long edge **1920 px, JPEG q80** (`flutter_image_compress`). Video: max **30 s**, **720p H.264** (`video_compress`).
- Require a GPS fix with accuracy ≤ 50 m (server rejects > 100 m). Read `isMocked` (geolocator); block capture if true (server rejects it too).
- Record `capturedAt` (UTC ISO-8601) at shutter time.

## 3. Upload (immediately or from the offline queue, within 24 h of capture)
1. `POST /api/v1/media/upload-url`
   `{ deviceId, kind: "PHOTO"|"VIDEO", contentType: "image/jpeg"|"image/webp"|"video/mp4", bytes, sha256 }`
   → `{ mediaId, uploadUrl, method: "PUT", headers, expiresInSeconds: 600 }`
2. `PUT uploadUrl` with exactly the returned `Content-Type` and the same byte count.
3. Build the manifest, sign it, confirm:
   ```json
   { "v": 1, "mediaId": "...", "deviceId": "...", "kind": "PHOTO",
     "sha256": "<hex of the uploaded file>", "capturedAt": "2026-10-24T09:15:02Z",
     "lat": 21.2514, "lng": 81.6296, "accuracyM": 7.5, "isMockLocation": false }
   ```
   - `manifestBytes = utf8(JSON)`; `signature = ECDSA-SHA256(manifestBytes)` in **DER** (Keystore default).
   - `POST /api/v1/media/{mediaId}/confirm` `{ manifest: base64url(manifestBytes), signature: base64(signature) }`
   - Send the manifest bytes you signed; the server verifies those exact bytes (no re-serialising).
4. Response: photos come back `READY`; videos `PROCESSING` → poll `GET /api/v1/media/{id}` until `READY` (they can be attached while processing).
   `422` = rejected for a stated reason (show it); `503` = scanner busy, retry confirm.

## 4. Attach
- File a complaint: `POST /complaints { …, mediaIds: [...] }` (1–5 photos + ≤ 1 video).
- Worker start / resolve: `mediaIds` with ≥ 1 photo, captured after the complaint was filed.
- A media item can be attached once, only by the user who captured it.
- Unattached uploads are deleted after 24 h.

## 5. Viewing
`GET /complaints/{id}/media` → items per stage (`COMPLAINT`, `WORK_START`, `RESOLUTION`) with
`url` and `thumbnailUrl` valid for 5 minutes; refetch the list instead of caching URLs.
Stored copies have all EXIF/GPS metadata removed; the location is returned as data.
