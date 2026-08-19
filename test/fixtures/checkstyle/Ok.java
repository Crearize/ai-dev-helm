package fixtures;

// Conforming fixture for stacks/java-springboot/lint/checkstyle/checkstyle.xml.
// Must produce ZERO findings under every module group (false-positive guard):
// named imports only, constants instead of magic numbers, specific exception
// types, empty catch allowed only via the `ignored` variable name, equals and
// hashCode overridden together, short and flat methods.

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.List;
import java.util.Objects;

public final class Ok {

  private static final int MAX_RETRY_COUNT = 5;
  private static final int DEFAULT_TIMEOUT_SECONDS = 30;

  private final String name;

  public Ok(String name) {
    this.name = name;
  }

  public int retryBudget(List<String> attempts) {
    if (attempts.size() > MAX_RETRY_COUNT) {
      return MAX_RETRY_COUNT;
    }
    return attempts.size();
  }

  public int parseOrDefault(String raw) {
    try {
      return Integer.parseInt(raw);
    } catch (NumberFormatException ignored) {
    }
    return DEFAULT_TIMEOUT_SECONDS;
  }

  public String describe() {
    try {
      return load();
    } catch (IOException e) {
      throw new UncheckedIOException("failed to load description", e);
    }
  }

  @Override
  public boolean equals(Object other) {
    if (this == other) {
      return true;
    }
    if (!(other instanceof Ok)) {
      return false;
    }
    Ok that = (Ok) other;
    return Objects.equals(this.name, that.name);
  }

  @Override
  public int hashCode() {
    return Objects.hash(name);
  }

  private String load() throws IOException {
    if (name == null) {
      throw new IOException("no name configured");
    }
    return name;
  }
}
