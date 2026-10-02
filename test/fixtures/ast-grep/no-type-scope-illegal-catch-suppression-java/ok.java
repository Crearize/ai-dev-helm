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

    // OK: the fully-qualified annotation at method scope (#160)
    @java.lang.SuppressWarnings("checkstyle:IllegalCatch")
    public void fullyQualifiedBoundaryMethod() {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: fully-qualified, method scope
        }
    }

    // OK: a SuppressWarnings type from another package is not
    // java.lang.SuppressWarnings - Checkstyle ignores it, so it suppresses
    // nothing at type scope and must not be flagged
    @com.example.SuppressWarnings("checkstyle:IllegalCatch")
    static final class OtherPackage {
    }

    @com/**/.example.SuppressWarnings("checkstyle:IllegalCatch")
    static final class OtherPackageWithComment {
    }

    private static void risky() {
    }
}
