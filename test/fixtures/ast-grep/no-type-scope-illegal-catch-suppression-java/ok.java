package fixtures;

public class Ok {

    // OK: method scope is the smallest enclosing declaration
    @SuppressWarnings("checkstyle:IllegalCatch")
    public void boundaryMethod() {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: thread outermost boundary
        }
    }

    public Ok() {
    }

    // OK: constructor scope is allowed
    @SuppressWarnings("checkstyle:IllegalCatch")
    public Ok(int seed) {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: constructor-level boundary
        }
    }

    public void localLambdaBoundary() {
        // OK: a lambda-holding local variable is allowed
        @SuppressWarnings("checkstyle:IllegalCatch")
        // 境界宣言: local lambda boundary
        Runnable r = () -> {
            try {
                risky();
            } catch (RuntimeException e) {
                // handled at the boundary
            }
        };
        r.run();
    }

    private static void risky() {
    }
}
