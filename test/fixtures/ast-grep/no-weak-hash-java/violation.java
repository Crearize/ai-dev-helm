package fixtures;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.Signature;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.NoSuchPaddingException;

public class Violation {

    // Violation 1: MD5 digest
    public MessageDigest md5() throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("MD5");
    }

    // Violation 2: SHA-1 digest
    public MessageDigest sha1() throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("SHA-1");
    }

    // Violation 3: lowercase spelling without the dash
    public MessageDigest sha1Alt() throws NoSuchAlgorithmException {
        return MessageDigest.getInstance("sha1");
    }

    // Violation 4: broken HMAC over SHA-1
    public Mac hmacSha1() throws NoSuchAlgorithmException {
        return Mac.getInstance("HmacSHA1");
    }

    // Violation 5: SHA-1 based digital signature
    public Signature sha1Signature() throws NoSuchAlgorithmException {
        return Signature.getInstance("SHA1withRSA");
    }

    // Violation 6: DES is a broken block cipher
    public Cipher des() throws NoSuchAlgorithmException, NoSuchPaddingException {
        return Cipher.getInstance("DES/CBC/PKCS5Padding");
    }

    // Violation 7: ECB mode leaks plaintext structure
    public Cipher ecb() throws NoSuchAlgorithmException, NoSuchPaddingException {
        return Cipher.getInstance("AES/ECB/PKCS5Padding");
    }
}
