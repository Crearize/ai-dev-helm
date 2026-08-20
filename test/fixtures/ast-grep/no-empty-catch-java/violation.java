package fixtures;

import java.io.IOException;

public class Violation {

    // Violation 1: completely empty catch block
    public void swallowSilently() {
        try {
            risky();
        } catch (IOException e) {
        }
    }

    // Violation 2: comment-only catch body is still empty
    public void swallowWithExcuse() {
        try {
            risky();
        } catch (IOException e) {
            // ignore, probably fine
        }
    }

    // Violation 3: block-comment-only catch body is still empty
    public void swallowWithBlockComment() {
        try {
            risky();
        } catch (IOException e) {
            /* intentionally ignored */
        } finally {
            cleanup();
        }
    }

    private void risky() throws IOException {
        throw new IOException("boom");
    }

    private void cleanup() {
        System.out.println("cleanup");
    }
}
