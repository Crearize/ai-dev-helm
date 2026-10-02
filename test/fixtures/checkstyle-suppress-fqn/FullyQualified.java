package fixtures;

// The fully-qualified annotation name suppresses every check in the class
// exactly like the simple name (#160) - this is why the ast-grep guard must
// match it.
@java.lang.SuppressWarnings("all")
public class FullyQualified {

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
