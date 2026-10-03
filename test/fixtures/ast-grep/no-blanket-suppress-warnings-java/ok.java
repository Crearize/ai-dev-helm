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

    // OK: javac's own suppression values are not Checkstyle suppression syntax
    // (negative controls for the false-positive the first cut of this rule had)
    @SuppressWarnings("unchecked")
    public void javacUnchecked() {
        java.util.List raw = new java.util.ArrayList();
        raw.add("x");
    }

    @SuppressWarnings({"rawtypes", "deprecation"})
    public void javacArrayValues() {
        java.util.List raw = new java.util.ArrayList();
        raw.size();
    }

    @SuppressWarnings("serial")
    public static class JavacSerial extends java.util.ArrayList<String> {
    }

    // OK: the fully-qualified annotation is held to the same rule, so a javac
    // value or the exact fixed form stays allowed through it (#160)
    @java.lang.SuppressWarnings("unchecked")
    public void fullyQualifiedJavacValue() {
        java.util.List raw = new java.util.ArrayList();
        raw.add("x");
    }

    @java . lang . /* fixed form */ SuppressWarnings("checkstyle:MagicNumber")
    public void fullyQualifiedFixedForm() {
        int budget = 42;
        report(budget);
    }

    // OK: a SuppressWarnings type from another package is not
    // java.lang.SuppressWarnings - Checkstyle's SuppressWarningsHolder ignores
    // it (it accepts only `SuppressWarnings` and `java.lang.SuppressWarnings`),
    // so it suppresses nothing and this rule must not flag it
    @com.example.SuppressWarnings("all")
    public void otherPackage() {
    }

    @com/**/.example.SuppressWarnings("all")
    public void otherPackageWithComment() {
    }

    @lang.SuppressWarnings("all")
    public void partialQualifier() {
    }

    @a.java.lang.SuppressWarnings("all")
    public void longerQualifier() {
    }

    @javax.lang.SuppressWarnings("all")
    public void nearMissQualifier() {
    }

    private void risky() {
    }

    private void report(int value) {
        System.out.println(value);
    }
}
