package fixtures;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.Signature;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.NoSuchPaddingException;

public class Ok {

    // OK: SHA-256 is a current, acceptable digest
    public MessageDigest sha256() throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("SHA-256");
    }

    // OK: near-miss - SHA-512 must not be caught by a sloppy "sha" prefix match
    public MessageDigest sha512() throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("SHA-512");
    }

    // OK: near-miss - the algorithm names appear only as data
    public static final String[] LEGACY_ALGORITHMS = { "MD5", "SHA-1" };

    // OK: near-miss - a modern HMAC
    public Mac hmac() throws NoSuchAlgorithmException {
        return Mac.getInstance("HmacSHA256");
    }

    // OK: near-miss - a SHA-256 signature
    public Signature signature() throws NoSuchAlgorithmException {
        return Signature.getInstance("SHA256withRSA");
    }

    // OK: near-miss - authenticated AES-GCM, not DES and not ECB
    public Cipher cipher() throws NoSuchAlgorithmException, NoSuchPaddingException {
        return Cipher.getInstance("AES/GCM/NoPadding");
    }
}
