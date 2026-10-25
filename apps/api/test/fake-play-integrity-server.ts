// Standalone fake Google (OAuth + Play Integrity) for the Dart contract test. Writes the settings
// the API needs to the file given as argv[2], then keeps serving until killed.
import { writeFileSync } from 'fs';
import { CERT, fakePlayIntegrity } from './fake-play-integrity';

void fakePlayIntegrity().then((fake) => {
  writeFileSync(process.argv[2], JSON.stringify({
    PLAY_INTEGRITY_MODE: 'enforce',
    PLAY_INTEGRITY_SERVICE_ACCOUNT_B64: fake.serviceAccountB64,
    PLAY_INTEGRITY_API_BASE: fake.apiBase,
    PLAY_INTEGRITY_CERT_SHA256: CERT,
  }));
});
