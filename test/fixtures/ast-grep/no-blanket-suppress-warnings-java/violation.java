package fixtures;

public class Violation {

    // Violation 1: blanket "all" suppresses every Checkstyle check
    @SuppressWarnings("all")
    public void suppressAll() {
    }

    // Violation 2: bare module name (no checkstyle: prefix)
    @SuppressWarnings("IllegalCatch")
    public void bareModuleName() {
    }

    // Violation 3: text-block value is still "all" - only the quoting differs
    @SuppressWarnings("""
        all""")
    public void textBlockAll() {
    }

    // Violation 4: checkstyle: prefix present but the module is not one this
    // preset declares - not the fixed allow-listed form
    @SuppressWarnings("checkstyle:MadeUpModule")
    public void unknownModule() {
    }

    // Violation 5: checkstyle: prefix with the wrong case - SuppressWarningsHolder
    // still honours it, so it is a misdirected reference, not the fixed form
    @SuppressWarnings("checkstyle:illegalcatch")
    public void wrongCasePrefixed() {
    }

    // Violation 6: bare module name with the optional Check suffix
    @SuppressWarnings("IllegalCatchCheck")
    public void bareModuleNameWithSuffix() {
    }

    // Violation 7: "all" in upper case is not honored by Checkstyle itself
    // (the comparison is case-sensitive on the literal "all"), but the intent
    // is unambiguously blanket suppression, so this rule still flags it as a
    // fail-closed guard rather than waiting for someone to notice the
    // annotation silently does nothing.
    @SuppressWarnings("ALL")
    public void suppressAllUpper() {
    }

    // Violation 8: fully-qualified class name with the Check suffix - Checkstyle
    // resolves the module by the short name at the end of the FQN, so this is
    // honored exactly like the bare module name form
    @SuppressWarnings("com.puppycrawl.tools.checkstyle.checks.coding.MagicNumberCheck")
    public void fqnModuleNameWithSuffix() {
    }

    // Violation 9: fully-qualified class name without the Check suffix - same
    // resolution, still honored
    @SuppressWarnings("com.puppycrawl.tools.checkstyle.checks.coding.MagicNumber")
    public void fqnModuleNameWithoutSuffix() {
    }

    // Near miss: a correctly-formed reference must not be flagged here (the
    // ok fixture is the false-positive guard; this is a sanity check that the
    // rule does not over-fire within the same file as real violations)
    @SuppressWarnings("checkstyle:IllegalCatch")
    // 境界宣言: near-miss control inside the violation fixture
    public void correctlyFormed() {
        try {
            risky();
        } catch (RuntimeException e) {
            // handled at the boundary
        }
    }

    private void risky() {
    }
}
