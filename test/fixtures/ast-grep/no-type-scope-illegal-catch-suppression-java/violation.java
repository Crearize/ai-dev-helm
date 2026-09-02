package fixtures;

public class Violation {

    // Violation 1: class-scope suppression revives file-wide suppression
    @SuppressWarnings("checkstyle:IllegalCatch")
    private static final class BoundaryClass {
        void swallow() {
            try {
                risky();
            } catch (RuntimeException e) {
                // handled
            }
        }
    }

    // Violation 2: field-scope suppression
    @SuppressWarnings("checkstyle:IllegalCatch")
    private final Runnable fieldHandler = () -> {
        try {
            risky();
        } catch (RuntimeException e) {
            // handled
        }
    };

    interface Bad {
        // Violation 3: interface constants parse as constant_declaration
        @SuppressWarnings("checkstyle:IllegalCatch")
        int MARKER = 1;
    }

    enum BadEnum {
        A;
        // Violation 4: enum member field-scope suppression
        @SuppressWarnings("checkstyle:IllegalCatch")
        static final int MARKER = 1;
    }

    // Violation 5: record type-scope suppression
    @SuppressWarnings("checkstyle:IllegalCatch")
    record BadRecord(int x) {
    }

    // Violation 6: @interface type-scope suppression
    @SuppressWarnings("checkstyle:IllegalCatch")
    @interface BadAnno {
    }

    // Near miss: method scope is allowed and must not be flagged in this file
    @SuppressWarnings("checkstyle:IllegalCatch")
    public void allowedAtMethodScope() {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: near-miss control - method scope is the minimal declaration
        }
    }

    static void risky() {
    }
}
