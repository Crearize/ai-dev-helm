# java-springboot lint assets

Pre-built static-analysis assets for the Java + Spring Boot stack: a Checkstyle preset and an ArchUnit test-class template. Every asset here is execution-verified before it ships (`lib/checkstyle-assets.test.js` runs the real Checkstyle CLI against violating and conforming fixtures; the ArchUnit template was compiled and evaluated with Gradle against a real Spring Boot 3 project).

Verified against: **Checkstyle 14.0.0** (all-in-one JAR, Java 21) and **ArchUnit 1.4.1** (`archunit-junit5`, JUnit 5, Spring Boot 3.2, Gradle 8.5).

## What a product receives

`ai-dev-helm init` copies these assets into the product; the lint-scaffolding skill does the wiring described below. From the product's perspective:

```
lint/
  checkstyle/
    checkstyle.xml            # the Checkstyle preset (grouped modules)
  archunit/
    ArchitectureRulesTest.java  # template - copy into src/test/java, replace __BASE_PACKAGE__
```

## Wiring Checkstyle (Gradle)

Add the built-in `checkstyle` plugin and point it at the copied config:

```groovy
plugins {
    id 'checkstyle'
}

checkstyle {
    toolVersion = '14.0.0'
    configFile = file('lint/checkstyle/checkstyle.xml')
    maxWarnings = 0
}
```

`gradlew check` (or `gradlew checkstyleMain checkstyleTest`) then runs it. Checkstyle 14.x requires a Java 17+ toolchain; this stack targets Java 21. `maxWarnings = 0` makes the warning-severity groups (complexity, hardcode) fail the build too - raise or drop it if a product wants those groups advisory-only.

### Module groups and opting out

`checkstyle.xml` is organized into commented groups. Each group is delimited by a `group: <name> (catalog ref)` comment; a product opts out of a group by deleting everything from its group comment down to the next group comment. Do not silently weaken a group in place - delete it whole and record why in the product's lint config notes.

| Group | Catalog | Severity | Modules |
| --- | --- | --- | --- |
| correctness | A1 | error | `AvoidStarImport`, `RegexpSinglelineJava` (bans `System.out` / `System.err` printing; use SLF4J), `EqualsHashCode` |
| error-handling | A3 | error | `EmptyCatchBlock` (empty catch allowed only when the exception variable is named `expected` or `ignored`), `IllegalCatch` (`Exception`, `Throwable`, `RuntimeException`) |
| dead-code | C3 | error | `UnusedImports`, `RedundantImport`, `UnusedLocalVariable` |
| complexity | C4 | warning | `MethodLength` (max 80), `CyclomaticComplexity` (max 15), `ParameterNumber` (max 6), `NestedIfDepth` (max 3) |
| hardcode | C6 | warning | `MagicNumber` (ignores -1/0/1/2, annotations, field declarations) |

Notes verified by execution:

- `UnusedLocalVariable` exists since Checkstyle 9.3; with `toolVersion` older than that, remove the module from the dead-code group (the other two modules stand alone).
- `NestedIfDepth` counts the outermost `if` as depth 0, so `max = 3` allows four levels of `if` and reports the fifth.
- The whole preset lives under `TreeWalker`; the `Checker` root sets `charset` UTF-8 and default severity `error`.

## Wiring ArchUnit (Gradle)

1. Add the test dependency (JUnit 5 engine is already provided by `spring-boot-starter-test`):

```groovy
dependencies {
    testImplementation 'com.tngtech.archunit:archunit-junit5:1.4.1'
}
```

2. Copy `lint/archunit/ArchitectureRulesTest.java` to `src/test/java/<base package path>/ArchitectureRulesTest.java` and replace every `__BASE_PACKAGE__` with the product's base package (e.g. `com.example.product`). The class then runs as a normal JUnit 5 test in `gradlew test`.

### Rules in the template and opting out

Each `@ArchTest` field is one rule; disable a single rule by deleting its field, or the whole suite by deleting the file. Never blank out a rule body to make it pass.

| Rule | Catalog | What it enforces |
| --- | --- | --- |
| `layer_dependencies_are_respected` | C1 | `..controller..` is depended on by no layer; `..service..` only by controller/service; `..repository..` only by service |
| `controllers_must_not_touch_repositories` | C1 | explicit controller-to-repository ban, kept even if the layered rule is relaxed |
| `top_level_packages_are_free_of_cycles` | C2 | no dependency cycles among the packages directly under the base package |

Layout tolerance is built in: `consideringOnlyDependenciesInLayers()` ignores dependencies whose origin or target is outside the three layer packages (so `config`, `security`, `scheduler` and similar packages do not trip the rule), and `withOptionalLayers(true)` accepts projects where a layer package does not exist yet. Tests themselves are excluded from analysis via `ImportOption.DoNotIncludeTests`.

## How these assets were verified

- Checkstyle: `java -jar checkstyle-14.0.0-all.jar -c checkstyle.xml` over `test/fixtures/checkstyle/` in this repo - `Violation.java` fires every module of every group, `Ok.java` yields zero findings. `lib/checkstyle-assets.test.js` repeats that run when `CHECKSTYLE_JAR` points at the all-in-one JAR (static XML shape checks always run).
- ArchUnit: the template (with `__BASE_PACKAGE__` instantiated) was compiled and executed via `gradlew test` inside a real Spring Boot 3.2 / Java 21 / jOOQ project with controller, service, repository plus non-layer packages; all three rules evaluated its production classes and passed.
