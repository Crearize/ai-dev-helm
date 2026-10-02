package fixtures;

// Comments and line breaks between the parts of the qualified name do not
// change the annotation type, so Checkstyle still honors it (#160).
@java/**/.lang./* x */ // y
SuppressWarnings("all")
public class CommentQualified {

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
