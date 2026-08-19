'use strict';

// harness/one-component-per-file
//
// Reports when a file exports MORE THAN ONE React component. An "exported
// React component" is an exported (named, default, or bottom `export { X }`)
// function declaration or arrow/function-expression variable whose name
// starts uppercase AND whose body contains JSX. Non-exported uppercase
// helpers do not count. The first exported component is fine; the second and
// every later one each get a report at their definition site.

// Generic AST walk looking for any JSX node. Deliberately walks into nested
// functions: a component that returns items.map(() => <li />) still "contains
// JSX".
function containsJsx(node, seen) {
  if (!node || typeof node !== 'object') return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) {
    return node.some((child) => containsJsx(child, seen));
  }
  if (typeof node.type !== 'string') return false;
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') return true;
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    const value = node[key];
    if (value && typeof value === 'object' && containsJsx(value, seen)) {
      return true;
    }
  }
  return false;
}

function startsUppercase(name) {
  return typeof name === 'string' && /^[A-Z]/.test(name);
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Allow at most one exported React component per file - split additional components into their own files. (Catalog: C7)',
    },
    schema: [],
    messages: {
      multipleComponents:
        "Component '{{name}}' is the {{ordinal}} exported component in this file. Keep one exported component per file and move the others out. (Catalog: C7)",
    },
  },

  create(context) {
    // name -> { node, index } for every top-level component candidate.
    const candidates = new Map();
    // Names exported via `export { X }` / `export default X` identifiers.
    const exportedNames = new Set();
    // Component nodes exported directly at their definition.
    const directlyExported = new Set();
    let order = 0;

    function addCandidate(name, node) {
      if (!candidates.has(name)) {
        candidates.set(name, { node, index: order });
        order += 1;
      }
    }

    function considerFunctionDeclaration(node, exported) {
      if (!node.id || !startsUppercase(node.id.name)) return;
      if (!containsJsx(node.body, new Set())) return;
      addCandidate(node.id.name, node);
      if (exported) directlyExported.add(node.id.name);
    }

    function considerVariableDeclaration(node, exported) {
      for (const decl of node.declarations) {
        if (decl.id.type !== 'Identifier') continue;
        if (!startsUppercase(decl.id.name)) continue;
        const init = decl.init;
        if (
          !init ||
          (init.type !== 'ArrowFunctionExpression' &&
            init.type !== 'FunctionExpression')
        ) {
          continue;
        }
        if (!containsJsx(init.body, new Set())) continue;
        addCandidate(decl.id.name, decl);
        if (exported) directlyExported.add(decl.id.name);
      }
    }

    return {
      Program(program) {
        for (const stmt of program.body) {
          if (stmt.type === 'FunctionDeclaration') {
            considerFunctionDeclaration(stmt, false);
          } else if (stmt.type === 'VariableDeclaration') {
            considerVariableDeclaration(stmt, false);
          } else if (stmt.type === 'ExportNamedDeclaration') {
            if (stmt.declaration) {
              if (stmt.declaration.type === 'FunctionDeclaration') {
                considerFunctionDeclaration(stmt.declaration, true);
              } else if (stmt.declaration.type === 'VariableDeclaration') {
                considerVariableDeclaration(stmt.declaration, true);
              }
            } else if (!stmt.source) {
              for (const spec of stmt.specifiers) {
                if (spec.local.type === 'Identifier') {
                  exportedNames.add(spec.local.name);
                }
              }
            }
          } else if (stmt.type === 'ExportDefaultDeclaration') {
            const decl = stmt.declaration;
            if (decl.type === 'FunctionDeclaration') {
              considerFunctionDeclaration(decl, true);
            } else if (decl.type === 'Identifier') {
              exportedNames.add(decl.name);
            }
          }
        }
      },

      'Program:exit'() {
        const exportedComponents = [];
        for (const [name, entry] of candidates) {
          if (directlyExported.has(name) || exportedNames.has(name)) {
            exportedComponents.push({ name, ...entry });
          }
        }
        exportedComponents.sort((a, b) => a.index - b.index);
        for (let i = 1; i < exportedComponents.length; i += 1) {
          const { name, node } = exportedComponents[i];
          context.report({
            node,
            messageId: 'multipleComponents',
            data: { name, ordinal: `${i + 1}.` },
          });
        }
      },
    };
  },
};
