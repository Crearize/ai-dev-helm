# java-springboot lint assets

Pre-built static-analysis assets for the Java + Spring Boot stack: a Checkstyle preset and an ArchUnit test-class template. The Checkstyle preset is **auto-verified**: `lib/checkstyle-assets.test.js` runs the real Checkstyle CLI (JAR-gated on `CHECKSTYLE_JAR`) against violating and conforming fixtures on every test run, and always runs static shape checks. The ArchUnit template is **manually verified** (it needs a JVM + a real Spring Boot project to execute); an automated structural guard in the same test file asserts the template keeps its `__BASE_PACKAGE__` placeholder, its ArchUnit imports and its rule count, but does not execute the rules.

Verified against: **Checkstyle 14.0.0** (all-in-one JAR, Java 21) and **ArchUnit 1.4.1** (`archunit-junit5`, JUnit 5, Spring Boot 3.2, Gradle 8.5).

## What a product receives

`ai-dev-helm init` copies these assets into the product; the lint-scaffolding skill does the wiring described below. From the product's perspective:

```
lint/
  checkstyle/
    checkstyle.xml            # the Checkstyle preset (grouped modules)
  archunit/
    ArchitectureRulesTest.java  # template - copy into src/test/java, replace __BASE_PACKAGE__
  mutation/
    pitest.gradle             # pulled in via apply from (see below)
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
| error-handling | A3 | error | `EmptyCatchBlock` (default config: an empty catch is a violation unless it carries an explanatory comment - the old `expected`/`ignored` name allowance was dropped), `IllegalCatch` (`Exception`, `Throwable`, `RuntimeException`) |
| security | B2 | error | `IllegalImport` (bans `sun.*` imports), `RegexpSinglelineJava` (bans `Runtime.getRuntime().exec` / `new ProcessBuilder` runtime process execution) |
| dead-code | C3 | error | `UnusedImports`, `RedundantImport`, `UnusedLocalVariable` |
| complexity | C4 | warning | `MethodLength` (max 80), `CyclomaticComplexity` (max 15), `ParameterNumber` (max 6), `NestedIfDepth` (max 3) |
| hardcode | C6 | warning | `MagicNumber` (ignores -1/0/1/2, annotations, field declarations) |

Notes verified by execution:

- `UnusedLocalVariable` exists since Checkstyle 9.3; with `toolVersion` older than that, remove the module from the dead-code group (the other two modules stand alone).
- `NestedIfDepth` counts the outermost `if` as depth 0, so `max = 3` allows four levels of `if` and reports the fifth.
- The whole preset lives under `TreeWalker`; the `Checker` root sets `charset` UTF-8 and default severity `error`.
- `EmptyCatchBlock` and the ast-grep rule `no-empty-catch-java` are deliberately kept in agreement: Checkstyle flags an empty catch that has no comment; the ast-grep rule is stricter (a comment-only body is still empty) and is the enforced rule when a product ships both. Do not re-add `exceptionVariableName` to `EmptyCatchBlock` - naming the variable `ignored` must not wave an empty catch through.
- The `security` group's `RegexpSinglelineJava` is a second instance of that module (the first, in `correctness`, bans `System.out`/`System.err`); both surface in output as `[RegexpSinglelineJava]`, distinguished by their messages.

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

- Checkstyle (auto-verified): `java -jar checkstyle-14.0.0-all.jar -c checkstyle.xml` over `test/fixtures/checkstyle/` in this repo - `Violation.java` fires every module of every group (correctness, error-handling, security, dead-code, complexity, hardcode), `Ok.java` yields zero findings. `lib/checkstyle-assets.test.js` repeats that run when `CHECKSTYLE_JAR` points at the all-in-one JAR (static XML shape checks, group-label/module mapping, and the ArchUnit template shape checks always run).
- ArchUnit (manually verified): the template (with `__BASE_PACKAGE__` instantiated) was compiled and executed via `gradlew test` inside a real Spring Boot 3.2 / Java 21 / jOOQ project with controller, service, repository plus non-layer packages; all three rules evaluated its production classes and passed. **This was a one-time manual run (ArchUnit 1.4.1, JUnit 5, Gradle 8.5), not repeated per test run** - the repo has a no-CI policy, so there is no automated ArchUnit execution. `lib/checkstyle-assets.test.js` guards the template's structure (placeholder, imports, `@ArchTest` count) so edits cannot silently break its shape.

### ArchUnit cost

The slice cycle rule `top_level_packages_are_free_of_cycles` (`slices().matching(...).beFreeOfCycles()`) is the most expensive rule in the template: it builds the full slice dependency graph and searches it for cycles, which grows with the number of top-level packages and inter-package edges. On a large codebase this dominates the ArchUnit run. If it becomes a bottleneck, move it to a less-frequent job (nightly / pre-merge) and keep the two cheaper layer-direction rules in the fast per-commit test run - delete the `@ArchTest` field in the fast copy and keep it in the slow one, rather than weakening the rule.

## Mutation testing (PIT)

`init` copies `lint/mutation/pitest.gradle` into the product; the lint-scaffolding skill does the wiring below. The snippet is a **PIT (Pitest) configuration** for Gradle products - a `pitest { }` extension block plus the two entry-point tasks `mutationFull` and `mutationDiff`. It is **manually verified** (it needs a JVM + a real Spring Boot project to execute); there is no automated PIT run in this repo (no-CI policy), and the shipped snippet is exercised against a real project in a one-time manual verification, like the ArchUnit template. The `pitest { }` block was verified that way; the `mutationDiff` diff-scope logic added later follows the same discipline and is structurally guarded by `lib/mutation-assets.test.js`.

```
lint/
  mutation/
    pitest.gradle             # pulled in via apply from; configures the pitest{} extension
```

### Wiring PIT (Gradle)

1. Declare the plugin id in the product's **root `plugins { }` block** - not in `pitest.gradle`. Gradle forbids the `plugins { }` DSL inside a script applied via `apply from`, so the plugin id has to live in the root build script while `pitest.gradle` only configures the extension the plugin registers:

```groovy
plugins {
    id 'info.solidsoft.pitest' version '1.15.0'
}

apply from: 'lint/mutation/pitest.gradle'
```

The `1.15.0` here is the **gradle-pitest-plugin** version (the Gradle integration), not the PIT core. It is independent of the PIT core version, which `pitest.gradle` pins explicitly to `1.16.1` via `pitestVersion` so the JUnit 5 companion (`junit5PluginVersion = '1.2.1'`) stays compatible regardless of the plugin version the product resolves. Use whatever recent gradle-pitest-plugin version you like here; the core stays pinned by the snippet.

2. In the copied `lint/mutation/pitest.gradle`, replace every `__BASE_PACKAGE__` with the product's base package (e.g. `com.example.product`), exactly as for the ArchUnit template. That sets `targetClasses` to the product's production classes.

The snippet sets `junit5PluginVersion` (Spring Boot tests are JUnit 5), `mutators = ['DEFAULTS']` (PIT's own default group of behaviour-changing mutators, pinned so the scope never silently widens to `STRONGER` / `ALL`), `outputFormats = ['XML', 'HTML']`, and `timestampedReports = false`. It deliberately sets **no `mutationThreshold`** or any other gate threshold: score gating is owned by quality-check (below).

### Entry points

`pitest.gradle` registers both entry points itself. Gradle task names cannot contain `:` (it is the project-path separator), hence these names rather than the JS-side `mutation:full` / `mutation:diff` script names:

- `gradle mutationFull` - the full-scope run (`gradle pitest` over everything under `targetClasses`, `__BASE_PACKAGE__.*`).
- `gradle mutationDiff -PmutationDiffBase=origin/main` - the diff-scoped run quality-check Step 3.5 uses. The snippet lists the production sources changed since the base ref (`git diff --name-only --relative --diff-filter=AMR <base>...HEAD -- src/main/java`), maps them to fully qualified class names with a trailing `*` (so inner and nested classes are covered) and narrows `targetClasses` to them. PIT mutates whole classes - line-level scoping is not available - so this is the smallest scope PIT supports. Paths are resolved relative to the project the snippet is applied to, which also works for one module of a multi-module build. Without the property the task fails fast with a message. An empty scope (no production class changed) is reported and the run completes without mutating anything (`failWhenNoMutations` is switched off for that run); quality-check records `mutation.reason: "empty_scope"`.

Products that keep a persisted PIT history (`historyInputLocation` / `historyOutputLocation`) can combine it with `mutationDiff` to make the loop re-runs cheaper; it is optional.

### Maven products

For a Maven build, use the `pitest-maven` plugin instead of this Gradle snippet: configure the `org.pitest:pitest-maven` plugin with the same intent - `targetClasses` set to the product base package, `mutators` at `DEFAULTS`, JUnit 5 support via `pitest-junit5-plugin`, XML + HTML `outputFormats`, and no `mutationThreshold`. For the diff scope, derive `targetClasses` from the changed sources the same way (a small script or profile passing `-DtargetClasses=...`). The scaffolding is Maven-specific but the score gating and thresholds are identical.

### How the score is gated

quality-check reads the **XML** report PIT writes (`build/reports/pitest/mutations.xml`), lists the survivors, triages them (gate mode) and compares the adjusted score against the risk-based thresholds and time budget defined in quality-policy section 2 - the single source for those numbers. This snippet never hardcodes them, and neither should the product's build files (overrides go through the harness settings contract described in that section, not here). Mutation runs are **local-only**; there is no CI job in this repo that runs PIT.
