package fixtures;

public class Violation {

    private static final class Constants {
        static final String ILLEGAL_CATCH = "checkstyle:IllegalCatch";
    }

    private static final String ILLEGAL_CATCH = "checkstyle:IllegalCatch";

    // Violation 1: constant reference - the value is not a literal in the
    // annotation itself, so grep-based review cannot see what is suppressed
    @SuppressWarnings(ILLEGAL_CATCH)
    public void constantReference() {
        try {
            risky();
        } catch (RuntimeException e) {
            // handled
        }
    }

    // Violation 2: field access through another type
    @SuppressWarnings(Constants.ILLEGAL_CATCH)
    public void fieldAccessReference() {
        try {
            risky();
        } catch (RuntimeException e) {
            // handled
        }
    }

    // Violation 3: string concatenation
    @SuppressWarnings("checkstyle:" + "IllegalCatch")
    public void concatenatedValue() {
        try {
            risky();
        } catch (RuntimeException e) {
            // handled
        }
    }

    private void risky() {
    }
}
