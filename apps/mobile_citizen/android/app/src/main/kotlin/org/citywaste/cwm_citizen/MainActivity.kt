package org.citywaste.cwm_citizen

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.IntegrityServiceException
import com.google.android.play.core.integrity.IntegrityTokenRequest
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
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
        // Play Integrity (classic request): the nonce comes from the server challenge, see
        // flutter_core Attestor. Errors are returned as codes the server can record.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "org.citywaste/play_integrity").setMethodCallHandler { call, result ->
            if (call.method != "token") return@setMethodCallHandler result.notImplemented()
            val nonce = call.argument<String>("nonce") ?: return@setMethodCallHandler result.error("ARG", "nonce missing", null)
            val project = call.argument<Number>("cloudProjectNumber")?.toLong() ?: 0L
            IntegrityManagerFactory.create(applicationContext)
                .requestIntegrityToken(IntegrityTokenRequest.builder().setNonce(nonce).setCloudProjectNumber(project).build())
                .addOnSuccessListener { result.success(it.token()) }
                .addOnFailureListener { e ->
                    val code = (e as? IntegrityServiceException)?.errorCode?.let { "PLAY_INTEGRITY_$it" } ?: e.javaClass.simpleName
                    result.error("INTEGRITY", code, null)
                }
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
