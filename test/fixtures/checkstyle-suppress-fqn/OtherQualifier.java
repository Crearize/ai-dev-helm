package fixtures;

// Contrast: a SuppressWarnings type from another package is not
// java.lang.SuppressWarnings, so Checkstyle ignores it and IllegalCatch still
// fires - the ast-grep guard correctly leaves it alone.
@com.example.SuppressWarnings("all")
public class OtherQualifier {

    void swallow() {
        try {
            risky();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void risky() {
    }
}
