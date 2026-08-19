package __BASE_PACKAGE__;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.Architectures.layeredArchitecture;
import static com.tngtech.archunit.library.dependencies.SlicesRuleDefinition.slices;

/**
 * Harness architecture rules for the java-springboot stack (catalog C1 / C2).
 *
 * <p>Template: the lint-scaffolding step copies this file into
 * {@code src/test/java/<base package path>/} and replaces every
 * {@code __BASE_PACKAGE__} with the product's base package (e.g.
 * {@code com.example.product}). Requires the {@code archunit-junit5} test
 * dependency (see stacks/java-springboot/lint/README.md). Execution-verified
 * with ArchUnit 1.4.1 on JUnit 5 / Spring Boot 3 / Java 21.
 *
 * <p>To disable a single rule, delete its {@code @ArchTest} field (or comment
 * it with a reason and a ticket). To disable the whole suite, delete the file.
 */
@AnalyzeClasses(
    packages = "__BASE_PACKAGE__",
    importOptions = ImportOption.DoNotIncludeTests.class)
public class ArchitectureRulesTest {

  /**
   * Catalog C1 - layer dependency direction. Controller must not be depended
   * on by any layer; Service only by Controller (and other Services);
   * Repository only by Service.
   *
   * <p>Layout tolerance: {@code consideringOnlyDependenciesInLayers()} ignores
   * dependencies whose origin or target lies outside the three layers, so
   * packages like {@code config}, {@code security} or {@code scheduler} do not
   * fail the rule; {@code withOptionalLayers(true)} accepts a project where a
   * layer package does not exist (yet).
   */
  @ArchTest
  static final ArchRule layer_dependencies_are_respected =
      layeredArchitecture()
          .consideringOnlyDependenciesInLayers()
          .withOptionalLayers(true)
          .layer("Controller").definedBy("..controller..")
          .layer("Service").definedBy("..service..")
          .layer("Repository").definedBy("..repository..")
          .whereLayer("Controller").mayNotBeAccessedByAnyLayer()
          .whereLayer("Service").mayOnlyBeAccessedByLayers("Controller", "Service")
          .whereLayer("Repository").mayOnlyBeAccessedByLayers("Service");

  /**
   * Catalog C1 - no Controller -> Repository shortcut. Redundant with the
   * layered rule above but kept as an explicit, self-describing guard: it
   * survives even if a product relaxes or deletes the layered rule.
   */
  @ArchTest
  static final ArchRule controllers_must_not_touch_repositories =
      noClasses()
          .that().resideInAPackage("..controller..")
          .should().dependOnClassesThat().resideInAPackage("..repository..");

  /**
   * Catalog C2 - no cyclic dependencies between the top-level packages
   * directly under the base package (controller, service, repository, dto,
   * ...). A cycle means responsibilities leak across module boundaries.
   */
  @ArchTest
  static final ArchRule top_level_packages_are_free_of_cycles =
      slices().matching("__BASE_PACKAGE__.(*)..").should().beFreeOfCycles();
}
