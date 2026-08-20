'use strict';

// harness/export-at-definition
//
// Reports `export { X }` / `export default X` statements that export an
// identifier declared elsewhere in the SAME file as a function, class, or
// variable: the export belongs at the definition site (`export function X`,
// `export default function X() {}`). Re-exports (`export { X } from './y'`)
// and exports of imported bindings are deliberately not reported - those
// cannot be moved to a definition site in this file.

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Export functions, classes, and variables at their definition site instead of a separate export statement. (Catalog: C7)',
    },
    schema: [],
    messages: {
      exportAtDefinition:
        "'{{name}}' is declared in this file - export it at its definition (`export function/const/class {{name}}`) instead of a separate export statement. (Catalog: C7)",
      exportDefaultAtDefinition:
        "'{{name}}' is declared in this file - default-export it at its definition (`export default function {{name}}() {}`) instead of a separate statement. (Catalog: C7)",
    },
  },

  create(context) {
    // Top-level names declared as function / class / variable, mapped to the
    // start position of their declaration so "declared earlier" is checkable.
    const localDeclarations = new Map();

    function collectDeclarations(program) {
      for (const stmt of program.body) {
        let decl = stmt;
        // `export function X` etc. still declares X locally; collecting it is
        // harmless because a definition-site export has no separate
        // export-specifier statement to report.
        if (
          (stmt.type === 'ExportNamedDeclaration' ||
            stmt.type === 'ExportDefaultDeclaration') &&
          stmt.declaration
        ) {
          decl = stmt.declaration;
        }
        if (
          (decl.type === 'FunctionDeclaration' ||
            decl.type === 'ClassDeclaration') &&
          decl.id
        ) {
          localDeclarations.set(decl.id.name, decl.range[0]);
        } else if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (d.id.type === 'Identifier') {
              localDeclarations.set(d.id.name, d.range[0]);
            }
          }
        }
      }
    }

    function isDeclaredEarlier(name, exportNode) {
      return (
        localDeclarations.has(name) &&
        localDeclarations.get(name) < exportNode.range[0]
      );
    }

    return {
      Program: collectDeclarations,

      ExportNamedDeclaration(node) {
        if (node.declaration || node.source) return; // definition-site or re-export
        for (const spec of node.specifiers) {
          if (
            spec.local.type === 'Identifier' &&
            isDeclaredEarlier(spec.local.name, node)
          ) {
            context.report({
              node: spec,
              messageId: 'exportAtDefinition',
              data: { name: spec.local.name },
            });
          }
        }
      },

      ExportDefaultDeclaration(node) {
        if (
          node.declaration.type === 'Identifier' &&
          isDeclaredEarlier(node.declaration.name, node)
        ) {
          context.report({
            node,
            messageId: 'exportDefaultAtDefinition',
            data: { name: node.declaration.name },
          });
        }
      },
    };
  },
};
