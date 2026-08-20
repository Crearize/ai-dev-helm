package fixtures;

import java.io.IOException;
import java.io.UncheckedIOException;

public class Ok {

    // OK: catch with real handling (wrap and rethrow)
    public void rethrows() {
        try {
            risky();
        } catch (IOException e) {
            throw new UncheckedIOException("risky failed", e);
        }
    }

    // OK: near-miss - comment plus a real statement must NOT be flagged
    public void handlesWithComment() {
        try {
            risky();
        } catch (IOException e) {
            // fall back to the cached value
            report(e);
        }
    }

    // OK: try/finally without any catch clause
    public void finallyOnly() {
        try {
            System.out.println("work");
        } finally {
            cleanup();
        }
    }

    private void risky() throws IOException {
        throw new IOException("boom");
    }

    private void report(Exception e) {
        System.out.println(e.getMessage());
    }

    private void cleanup() {
        System.out.println("cleanup");
    }
}
