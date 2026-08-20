package fixtures;

// Violating fixture for stacks/java-springboot/lint/checkstyle/checkstyle.xml.
// Every module group in the config must produce at least one finding here;
// lib/checkstyle-assets.test.js asserts each module name appears in the output.

import java.util.*; // group correctness: AvoidStarImport
import java.lang.String; // group dead-code: RedundantImport (java.lang)
import java.io.IOException;
import java.math.BigDecimal; // group dead-code: UnusedImports (never referenced)
import sun.misc.Unsafe; // group security: IllegalImport (sun.* package)

public class Violation {

  // group correctness: RegexpSinglelineJava (System.out/err.println)
  public void log() {
    System.out.println("debug output");
    System.err.println("error output");
  }

  // group correctness: EqualsHashCode (equals overridden without hashCode)
  @Override
  public boolean equals(Object other) {
    return other == this;
  }

  // group error-handling: EmptyCatchBlock (empty, no comment, name not expected/ignored)
  public void swallow() {
    try {
      thrower();
    } catch (IOException e) {
    }
  }

  // group security: RegexpSinglelineJava (Runtime.getRuntime().exec)
  public void spawn() throws IOException {
    Runtime.getRuntime().exec("rm -rf /tmp/data");
  }

  // group error-handling: IllegalCatch (java.lang.Exception)
  public String broadCatch() {
    try {
      thrower();
      return "ok";
    } catch (Exception e) {
      return e.getMessage();
    }
  }

  // group dead-code: UnusedLocalVariable / group hardcode: MagicNumber
  public int deadLocal() {
    int unused = 5;
    return 42;
  }

  // group complexity: ParameterNumber (7 > max 6)
  public int overload(int a, int b, int c, int d, int e, int f, int g) {
    return a + b + c + d + e + f + g;
  }

  // group complexity: NestedIfDepth (outermost if is depth 0; depth 4 > max 3)
  public int deeplyNested(int v) {
    if (v > 0) {
      if (v > 10) {
        if (v > 20) {
          if (v > 30) {
            if (v > 40) {
              return 4;
            }
          }
        }
      }
    }
    return 0;
  }

  // group complexity: CyclomaticComplexity (17 > max 15)
  public int branchy(int v) {
    int r = 0;
    if (v == 3) {
      r++;
    }
    if (v == 4) {
      r++;
    }
    if (v == 5) {
      r++;
    }
    if (v == 6) {
      r++;
    }
    if (v == 7) {
      r++;
    }
    if (v == 8) {
      r++;
    }
    if (v == 9) {
      r++;
    }
    if (v == 10) {
      r++;
    }
    if (v == 11) {
      r++;
    }
    if (v == 12) {
      r++;
    }
    if (v == 13) {
      r++;
    }
    if (v == 14) {
      r++;
    }
    if (v == 15) {
      r++;
    }
    if (v == 16) {
      r++;
    }
    if (v == 17) {
      r++;
    }
    if (v == 18) {
      r++;
    }
    return r;
  }

  // group complexity: MethodLength (> max 80 lines)
  public int longMethod() {
    int total = 0;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    total += 1;
    return total;
  }

  private void thrower() throws IOException {
    throw new IOException("boom");
  }
}
