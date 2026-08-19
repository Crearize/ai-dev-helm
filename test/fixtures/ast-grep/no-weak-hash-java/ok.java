package fixtures;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import javax.crypto.Mac;

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

    // OK: near-miss - a different getInstance factory entirely
    public Mac hmac() throws NoSuchAlgorithmException {
        return Mac.getInstance("HmacSHA256");
    }
}
