package fixtures;

// Control: no suppression, so IllegalCatch must fire here.
public class Unsuppressed {

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
