package fixtures;

public class Ok {

    // OK: plain string literal, no key
    @SuppressWarnings("checkstyle:IllegalCatch")
    public void plainLiteral() {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: plain literal boundary
        }
    }

    // OK: plain string literal via the explicit `value =` key form - the key
    // identifier itself is not the suppressed value and must not be flagged
    @SuppressWarnings(value = "checkstyle:IllegalCatch")
    public void keyedLiteral() {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: keyed literal boundary
        }
    }

    // OK: array of plain string literals
    @SuppressWarnings({"checkstyle:IllegalCatch", "checkstyle:MagicNumber"})
    public void arrayOfLiterals() {
        int budget = 42;
        try {
            risky();
        } catch (RuntimeException e) {
            report(budget);
        }
    }

    // OK: the fully-qualified annotation with a plain literal (#160)
    @java.lang.SuppressWarnings("checkstyle:IllegalCatch")
    public void fullyQualifiedLiteral() {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: fully-qualified literal boundary
        }
    }

    // OK: a SuppressWarnings type from another package is not
    // java.lang.SuppressWarnings - Checkstyle ignores it, so a non-literal
    // value on it suppresses nothing and must not be flagged
    @com.example.SuppressWarnings(MARKER)
    public void otherPackageConstant() {
    }

    @com/* x */.example.SuppressWarnings(MARKER)
    public void otherPackageConstantWithComment() {
    }

    private static final String MARKER = "unrelated";

    private void risky() {
    }

    private void report(int value) {
        System.out.println(value);
    }
}
