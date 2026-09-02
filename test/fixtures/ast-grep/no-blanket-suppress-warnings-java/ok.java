package fixtures;

public class Ok {

    // OK: exact checkstyle:<ModuleName> form for a real preset module
    @SuppressWarnings("checkstyle:IllegalCatch")
    public void boundaryDeclared() {
        try {
            risky();
        } catch (RuntimeException e) {
            // 境界宣言: verified boundary, exact allow-listed reference
        }
    }

    // OK: a different real preset module, still the exact fixed form
    @SuppressWarnings("checkstyle:MagicNumber")
    public void magicNumberBoundary() {
        int budget = 42;
        report(budget);
    }

    private void risky() {
    }

    private void report(int value) {
        System.out.println(value);
    }
}
