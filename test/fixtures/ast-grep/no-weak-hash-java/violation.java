package fixtures;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

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
}
