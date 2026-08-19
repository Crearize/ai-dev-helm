'use strict';

// harness/no-forwardref
//
// React 19 passes `ref` as a regular prop to function components, so
// `forwardRef` is unnecessary indirection. This rule reports:
//   (a) a named `forwardRef` import from 'react' (aliased or not),
//   (b) any `React.forwardRef(...)` member call,
//   (c) calls to a local binding created by (a).
// A `forwardRef` imported from any OTHER module is a different function and
// is deliberately left alone.

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow React.forwardRef: React 19 delivers ref as a regular prop, so forwardRef is unnecessary indirection. (Catalog: A1)',
    },
    schema: [],
    messages: {
      noForwardRefImport:
        // Wording note: this string must not contain a quoted module name
        // after the word "from" - the repo's own import-exists cross-linter
        // scans string literals for `from '<spec>'` patterns.
        'Do not import forwardRef out of the react package. React 19 passes ref as a regular prop - accept `ref` in the props object instead. (Catalog: A1)',
      noForwardRefCall:
        'Do not wrap components in forwardRef. React 19 passes ref as a regular prop - accept `ref` in the props object instead. (Catalog: A1)',
    },
  },

  create(context) {
    // Local names bound to react's forwardRef via named import.
    const reactForwardRefLocals = new Set();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'react') return;
        for (const spec of node.specifiers) {
          if (
            spec.type === 'ImportSpecifier' &&
            spec.imported.type === 'Identifier' &&
            spec.imported.name === 'forwardRef'
          ) {
            reactForwardRefLocals.add(spec.local.name);
            context.report({ node: spec, messageId: 'noForwardRefImport' });
          }
        }
      },

      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'Identifier' &&
          reactForwardRefLocals.has(callee.name)
        ) {
          context.report({ node, messageId: 'noForwardRefCall' });
          return;
        }
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'forwardRef' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'React'
        ) {
          context.report({ node, messageId: 'noForwardRefCall' });
        }
      },
    };
  },
};
