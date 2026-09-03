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

    private void risky() {
    }

    private void report(int value) {
        System.out.println(value);
    }
}
