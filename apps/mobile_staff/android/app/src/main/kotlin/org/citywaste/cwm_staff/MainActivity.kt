package org.citywaste.cwm_staff

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.io.File
import java.security.spec.ECGenParameterSpec

/**
 * Capture-signing key (EC P-256) held in Android Keystore, StrongBox-backed when the phone has it.
 * The private key is non-exportable; Dart only receives the public key and signatures
 * (see flutter_core KeystoreSigner and docs/MEDIA_CAPTURE_CONTRACT.md).
 */
class MainActivity : FlutterActivity() {
    private val alias = "cwm_capture_signing_key"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "org.citywaste/device_integrity").setMethodCallHandler { call, result ->
            if (call.method == "check") result.success(integrity()) else result.notImplemented()
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "org.citywaste/device_key").setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "publicKey" -> result.success(Base64.encodeToString(entry().certificate.publicKey.encoded, Base64.NO_WRAP))
                    "sign" -> {
                        val data = call.argument<ByteArray>("data") ?: return@setMethodCallHandler result.error("ARG", "data missing", null)
                        val signature = Signature.getInstance("SHA256withECDSA").run {
                            initSign(entry().privateKey)
                            update(data)
                            sign()
                        }
                        result.success(Base64.encodeToString(signature, Base64.NO_WRAP))
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("KEY_ERROR", e.message, null)
            }
        }
    }

    /**
     * Root / tamper heuristics for the Staff app. Bypassable by design (Magisk DenyList etc.);
     * they stop casual misuse. Server-side Play Integrity attestation is the real control.
     */
    private fun integrity(): Map<String, Any> {
        val reasons = mutableListOf<String>()
        if (Build.TAGS?.contains("test-keys") == true) reasons += "test-keys build"
        val suPaths = listOf(
            "/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/su", "/system/bin/.ext/su",
            "/system/usr/we-need-root/su", "/data/local/su", "/data/local/bin/su", "/data/local/xbin/su",
            "/su/bin/su", "/system/app/Superuser.apk", "/data/adb/magisk", "/sbin/.magisk",
        )
        suPaths.firstOrNull { File(it).exists() }?.let { reasons += "found $it" }
        return mapOf("compromised" to reasons.isNotEmpty(), "reasons" to reasons)
    }

    private fun entry(): KeyStore.PrivateKeyEntry {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!store.containsAlias(alias)) generate()
        return store.getEntry(alias, null) as KeyStore.PrivateKeyEntry
    }

    private fun generate() {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try {
            generator.initialize(spec(strongBox = true))
            generator.generateKeyPair()
        } catch (e: Exception) {
            // No StrongBox on this phone: fall back to the TEE-backed Keystore (still non-exportable).
            generator.initialize(spec(strongBox = false))
            generator.generateKeyPair()
        }
    }
}
